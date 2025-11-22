// server/socket-server.ts
import { Server } from 'socket.io'
import { createServer } from 'http'
import express from 'express'
import cors from 'cors'

const app = express()
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.CLIENT_URL 
    : ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true
}))
app.use(express.json({ limit: '10mb' }))

const server = createServer(app)

// Data Store with TTL cleanup
const rooms = new Map()
const ROOM_TIMEOUT = 30 * 60 * 1000 // 30 minutes

const io = new Server(server, {
  cors: { 
    origin: process.env.NODE_ENV === 'production' ? process.env.CLIENT_URL : '*',
    methods: ["GET", "POST"],
    credentials: true
  },
  maxHttpBufferSize: 10e6,
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

function getOrCreateRoom(roomId: string) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      locked: false,
      password: null,
      hostId: null,
      members: new Map(),
      whiteboardDrawings: [],
      whiteboardBackground: null,
      allowedUsers: new Set(),
      lastActivity: Date.now(),
      handRaised: new Set(), // New: track raised hands
    })
  }
  const room = rooms.get(roomId)
  room.lastActivity = Date.now()
  return room
}

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`)
  
  socket.on('join-room', ({ roomId, userId, userName, password }: { roomId: string; userId: string; userName: string; password?: string }) => {
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
        room.allowedUsers.add(userId) // Host can always draw
        console.log(`Host set for room ${roomId}: ${userId}`)
      }

      socket.join(roomId)
      socket.data = { userId, roomId, userName }
      
      // Store member with permissions
      room.members.set(userId, {
        id: userId,
        name: userName,
        isModerator: room.hostId === userId,
        canDraw: room.allowedUsers.has(userId),
        handRaised: room.handRaised.has(userId) // New: include hand raise status
      })

      console.log(`User joined room ${roomId}: ${userId}, Total members: ${room.members.size}`)

      // Send room state to joining user
      socket.emit('room-state', {
        locked: room.locked,
        hostId: room.hostId,
        members: Array.from(room.members.values()),
        canDraw: room.allowedUsers.has(userId)
      })

      // Send existing whiteboard drawings and background
      socket.emit('whiteboard:state', { 
        drawings: room.whiteboardDrawings,
        background: room.whiteboardBackground
      })

      // Notify all room members about new member
      socket.to(roomId).emit('room-members', Array.from(room.members.values()))

    } catch (error) {
      console.error('Error joining room:', error)
      socket.emit('error', 'Failed to join room')
    }
  })

  // Room locking
  socket.on('room:lock', ({ roomId, password }: { roomId: string; password: string }) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.hostId === socket.data.userId && password) {
      room.locked = true
      room.password = password
      console.log(`Room locked: ${roomId} by host ${socket.data.userId}`)
      io.to(roomId).emit('room:locked')
    }
  })

  socket.on('room:unlock', (roomId: string) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.hostId === socket.data.userId) {
      room.locked = false
      room.password = null
      console.log(`Room unlocked: ${roomId} by host ${socket.data.userId}`)
      io.to(roomId).emit('room:unlocked')
    }
  })

  // Chat messages with file upload
  socket.on('chat:send', ({ roomId, message }: { roomId: string; message: any }) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    try {
      // Rate limiting
      if (!socket.data.lastChatTime || Date.now() - socket.data.lastChatTime > 1000) {
        // Add unique ID to prevent duplicates
        message.id = `${socket.data.userId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        
        // Broadcast to ALL users including sender
        io.to(roomId).emit('chat:receive', {
          ...message,
          isMe: false // Let clients determine if it's their own message
        })
        
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
  socket.on('whiteboard:enable', (roomId: string) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.hostId === socket.data.userId) {
      console.log(`Whiteboard enabled for room ${roomId} by host ${socket.data.userId}`)
      io.to(roomId).emit('whiteboard:enable')
    }
  })

  socket.on('whiteboard:disable', (roomId: string) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.hostId === socket.data.userId) {
      console.log(`Whiteboard disabled for room ${roomId} by host ${socket.data.userId}`)
      io.to(roomId).emit('whiteboard:disable')
    }
  })

  // Whiteboard drawing sync
  socket.on('whiteboard:drawing', ({ roomId, drawing }: { roomId: string; drawing: any }) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    // Only allowed users can draw
    if (room.allowedUsers.has(socket.data.userId)) {
      // Add unique ID to prevent duplicates
      drawing.id = `${socket.data.userId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      room.whiteboardDrawings.push(drawing)
      // Broadcast to all other users in the room (excluding sender)
      socket.to(roomId).emit('whiteboard:drawing', { drawing })
    }
  })

  // Whiteboard background image
  socket.on('whiteboard:background', ({ roomId, background }: { roomId: string; background: string }) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.allowedUsers.has(socket.data.userId)) {
      room.whiteboardBackground = background
      socket.to(roomId).emit('whiteboard:background', { background })
    }
  })

  // Whiteboard clear
  socket.on('whiteboard:clear', (roomId: string) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.allowedUsers.has(socket.data.userId)) {
      room.whiteboardDrawings = []
      room.whiteboardBackground = null
      socket.to(roomId).emit('whiteboard:clear')
      console.log(`Whiteboard cleared for room ${roomId} by user ${socket.data.userId}`)
    }
  })

  // Allow user to draw
  socket.on('whiteboard:allow-user', ({ roomId, userId, allow }: { roomId: string; userId: string; allow: boolean }) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.hostId === socket.data.userId) {
      if (allow) {
        room.allowedUsers.add(userId)
      } else {
        room.allowedUsers.delete(userId)
      }
      
      // Update member permissions
      const member = room.members.get(userId)
      if (member) {
        member.canDraw = allow
      }
      
      io.to(roomId).emit('whiteboard:user-permission', { userId, canDraw: allow })
      io.to(roomId).emit('room-members', Array.from(room.members.values()))
      console.log(`User ${userId} ${allow ? 'allowed' : 'disallowed'} to draw in room ${roomId}`)
    }
  })

  // NEW: Make user host
  socket.on('host:make-host', ({ roomId, userId }: { roomId: string; userId: string }) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.hostId === socket.data.userId) {
      // Update old host
      const oldHost = room.members.get(room.hostId)
      if (oldHost) {
        oldHost.isModerator = false
      }
      
      // Set new host
      room.hostId = userId
      const newHost = room.members.get(userId)
      if (newHost) {
        newHost.isModerator = true
      }
      
      // New host can always draw
      room.allowedUsers.add(userId)
      
      io.to(roomId).emit('host:changed', { newHostId: userId })
      io.to(roomId).emit('room-members', Array.from(room.members.values()))
      console.log(`Host changed to ${userId} in room ${roomId}`)
    }
  })

  // NEW: Hand raise system
  socket.on('hand:raise', (roomId: string) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    room.handRaised.add(socket.data.userId)
    
    const member = room.members.get(socket.data.userId)
    if (member) {
      member.handRaised = true
    }
    
    io.to(roomId).emit('hand:raised', { userId: socket.data.userId, userName: socket.data.userName })
    io.to(roomId).emit('room-members', Array.from(room.members.values()))
  })

  socket.on('hand:lower', (roomId: string) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    room.handRaised.delete(socket.data.userId)
    
    const member = room.members.get(socket.data.userId)
    if (member) {
      member.handRaised = false
    }
    
    io.to(roomId).emit('hand:lowered', { userId: socket.data.userId })
    io.to(roomId).emit('room-members', Array.from(room.members.values()))
  })

  socket.on('hand:lower-all', (roomId: string) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.hostId === socket.data.userId) {
      room.handRaised.clear()
      room.members.forEach(member => {
        member.handRaised = false
      })
      
      io.to(roomId).emit('hand:lowered-all')
      io.to(roomId).emit('room-members', Array.from(room.members.values()))
    }
  })

  // Moderator controls
  socket.on('moderator:mute-user', ({ roomId, userId }: { roomId: string; userId: string }) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.hostId === socket.data.userId) {
      // Notify the user to be muted
      socket.to(userId).emit('moderator:force-mute')
      console.log(`User ${userId} muted by host ${socket.data.userId}`)
    }
  })

  socket.on('moderator:remove-user', ({ roomId, userId }: { roomId: string; userId: string }) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    
    const room = getOrCreateRoom(roomId)
    if (room.hostId === socket.data.userId) {
      // Force user to leave
      socket.to(userId).emit('moderator:force-leave')
      console.log(`User ${userId} removed by host ${socket.data.userId}`)
    }
  })

  // Reactions
  socket.on('reaction:send', ({ roomId, reaction }: { roomId: string; reaction: any }) => {
    if (!socket.data?.userId || !socket.data?.roomId) return
    // Add unique ID to prevent duplicates
    reaction.id = `${socket.data.userId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    socket.to(roomId).emit('reaction:send', reaction)
  })

  // Handle disconnect
  socket.on('disconnect', (reason: string) => {
    console.log(`Socket disconnected: ${socket.id}, reason: ${reason}`)
    
    if (socket.data?.roomId && socket.data?.userId) {
      const { roomId, userId } = socket.data
      
      if (rooms.has(roomId)) {
        const room = rooms.get(roomId)
        room.members.delete(userId)
        room.allowedUsers.delete(userId)
        room.handRaised.delete(userId)
        console.log(`User left room ${roomId}: ${userId}, Remaining members: ${room.members.size}`)
        
        // Handle host disconnection
        if (room.hostId === userId) {
          const remainingMembers = Array.from(room.members.values())
          room.hostId = remainingMembers.length > 0 ? remainingMembers[0].id : null
          
          if (room.hostId) {
            // Make new host a moderator and allow to draw
            const newHost = room.members.get(room.hostId)
            if (newHost) {
              newHost.isModerator = true
              room.allowedUsers.add(room.hostId)
            }
            console.log(`Host changed for room ${roomId}: ${room.hostId}`)
            // Notify new host
            io.to(roomId).emit('room-state', {
              locked: room.locked,
              hostId: room.hostId,
              members: Array.from(room.members.values()),
            })
          } else {
            // No members left, disable whiteboard
            io.to(roomId).emit('whiteboard:disable')
            console.log(`All users left room ${roomId}, cleaning up`)
          }
        }
        
        if (room.members.size > 0) {
          io.to(roomId).emit('room-members', Array.from(room.members.values()))
        } else {
          // Remove empty room
          rooms.delete(roomId)
        }
      }
    }
  })
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => console.log(`> Socket.IO Server running on port ${PORT}`))

export { io, server }