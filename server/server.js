import express from 'express'
import http from 'http'
import cors from 'cors'
import { Server } from 'socket.io'

const app = express()
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.CLIENT_URL 
    : '*',
  credentials: true
}))
app.use(express.json({ limit: '5mb' }))

const server = http.createServer(app)

// Data Store with TTL cleanup
const rooms = new Map()
const ROOM_TIMEOUT = 30 * 60 * 1000 // 30 minutes

const io = new Server(server, {
  cors: { 
    origin: process.env.NODE_ENV === 'production' ? process.env.CLIENT_URL : '*',
    methods: ["GET", "POST"],
    credentials: true
  },
  maxHttpBufferSize: 5e6, // 5MB
  pingTimeout: 60000,
  pingInterval: 25000,
})

// Room cleanup scheduler
setInterval(() => {
  const now = Date.now()
  rooms.forEach((room, roomId) => {
    if (room.lastActivity && now - room.lastActivity > ROOM_TIMEOUT) {
      console.log(`Cleaning up inactive room: ${roomId}`)
      rooms.delete(roomId)
    }
  })
}, 60000)

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      locked: false,
      password: null,
      hostId: null,
      members: new Set(),
      lastActivity: Date.now(),
    })
  }
  const room = rooms.get(roomId)
  room.lastActivity = Date.now() // Update activity timestamp
  return room
}

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`)
  
  socket.on('join-room', ({ roomId, userId, password }) => {
    if (!roomId || !userId) {
      socket.emit('error', 'Invalid room or user ID')
      return
    }

    try {
      const room = getOrCreateRoom(roomId)

      // Check if room is locked and user is not host
      if (room.locked && room.hostId && room.hostId !== userId) {
        if (room.password !== password) {
          socket.emit('error:password-required')
          return
        }
      }

      // Set host if none exists
      if (!room.hostId) {
        room.hostId = userId
        console.log(`Host set for room ${roomId}: ${userId}`)
      }

      socket.join(roomId)
      socket.data = { userId, roomId }
      
      room.members.add(userId)
      console.log(`User joined room ${roomId}: ${userId}, Total members: ${room.members.size}`)

      // Send room state to joining user
      socket.emit('room-state', {
        locked: room.locked,
        hostId: room.hostId,
        members: [...room.members],
      })

      // Notify all room members about new member
      io.to(roomId).emit('room-members', [...room.members])

    } catch (error) {
      console.error('Error joining room:', error)
      socket.emit('error', 'Failed to join room')
    }
  })

  // Room locking
  socket.on('room:lock', ({ roomId, password }) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.hostId === socket.data.userId && password) {
      room.locked = true
      room.password = password
      console.log(`Room locked: ${roomId} by host ${socket.data.userId}`)
      io.to(roomId).emit('room:locked')
    }
  })

  socket.on('room:unlock', (roomId) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.hostId === socket.data.userId) {
      room.locked = false
      room.password = null
      console.log(`Room unlocked: ${roomId} by host ${socket.data.userId}`)
      io.to(roomId).emit('room:unlocked')
    }
  })

  // Chat messages
  socket.on('chat:send', ({ roomId, message }) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    try {
      // Validate message
      if (!message || typeof message !== 'object') {
        socket.emit('error', 'Invalid message format')
        return
      }

      // Rate limiting
      if (!socket.data.lastChatTime || Date.now() - socket.data.lastChatTime > 1000) {
        io.to(roomId).emit('chat:receive', message)
        socket.data.lastChatTime = Date.now()
      } else {
        socket.emit('error', 'Message rate limit exceeded')
      }
    } catch (error) {
      console.error('Error sending chat message:', error)
      socket.emit('error', 'Failed to send message')
    }
  })

  // Whiteboard control - Enable/Disable
  socket.on('whiteboard:enable', (roomId) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.hostId === socket.data.userId) {
      console.log(`Whiteboard enabled for room ${roomId} by host ${socket.data.userId}`)
      io.to(roomId).emit('whiteboard:enable')
    }
  })

  socket.on('whiteboard:disable', (roomId) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.hostId === socket.data.userId) {
      console.log(`Whiteboard disabled for room ${roomId} by host ${socket.data.userId}`)
      io.to(roomId).emit('whiteboard:disable')
    }
  })

  // Whiteboard sync - handle drawing commands
  socket.on('whiteboard:sync', ({ roomId, ...command }) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.hostId === socket.data.userId) {
      // Broadcast to all room members except sender
      socket.to(roomId).emit('whiteboard:sync', { 
        roomId, 
        ...command,
        senderId: socket.data.userId
      })
    }
  })

  // Handle disconnect
  socket.on('disconnect', (reason) => {
    console.log(`Socket disconnected: ${socket.id}, reason: ${reason}`)
    
    if (socket.data?.roomId && socket.data?.userId) {
      const { roomId, userId } = socket.data
      
      if (rooms.has(roomId)) {
        const room = rooms.get(roomId)
        room.members.delete(userId)
        console.log(`User left room ${roomId}: ${userId}, Remaining members: ${room.members.size}`)
        
        // Handle host disconnection
        if (room.hostId === userId) {
          const remainingMembers = [...room.members]
          room.hostId = remainingMembers.length > 0 ? remainingMembers[0] : null
          
          if (room.hostId === null) {
            // No members left, disable whiteboard and consider room cleanup
            io.to(roomId).emit('whiteboard:disable')
            console.log(`Host left room ${roomId}, new host: ${room.hostId}`)
          } else {
            console.log(`Host changed for room ${roomId}: ${room.hostId}`)
            // Notify new host
            io.to(roomId).emit('room-state', {
              locked: room.locked,
              hostId: room.hostId,
              members: remainingMembers,
            })
          }
        }
        
        io.to(roomId).emit('room-members', [...room.members])
      }
    }
  })
})

const PORT = process.env.PORT || 8080
server.listen(PORT, () => console.log(`> Realtime Server running on port ${PORT}`))