'use client'

import { useUser } from "@clerk/nextjs"
import {
  CallControls,
  PaginatedGridLayout,
  SpeakerLayout,
  useCallStateHooks,
  CallingState,
  useCall,
} from "@stream-io/video-react-sdk"
import React, { useEffect, useRef, useState, useCallback } from "react"
import Loading from "./Loading"
import { usePathname, useRouter } from "next/navigation"
import { Button } from "./ui/button"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "./ui/dropdown-menu"
import {
  LayoutList, Users, Pencil, X,
  Lock, LockOpen, MessageSquare, Send, Paperclip,
  Moon, Sun, AlertCircle, Share2, 
  ScreenShare as ScreenShareIcon, MoreVertical,
  Hand, ThumbsUp, Heart, Star, MessageCircle,
  Minimize2, Maximize2, Download, Trash2,
  Circle, Square, Type, Eraser, Mic, Video,
  Image as ImageIcon, Move, Triangle, ArrowRight,
  Crown, UserCheck, UserX, Smile, ZoomIn, ZoomOut,
  Settings, RotateCcw, MousePointer
} from "lucide-react"
import { io, Socket } from "socket.io-client"

// --- Types ---
type CallLayoutType = 'grid' | 'speaker-left' | 'speaker-right'
type WhiteboardMode = 'split' | 'full'
type ChatMode = 'normal' | 'full'
type ReactionType = 'hand' | 'thumbs-up' | 'heart' | 'star' | 'message'
type DrawingTool = 'pen' | 'rectangle' | 'circle' | 'line' | 'text' | 'eraser' | 'triangle' | 'arrow' | 'select'

interface ChatMessage {
  id: string
  senderId: string
  senderName: string
  text?: string
  fileData?: string
  type: 'text' | 'file'
  time: string
  isMe?: boolean
}

interface Reaction {
  id: string
  type: ReactionType
  senderId: string
  senderName: string
  time: string
}

interface DrawingData {
  type: DrawingTool
  points: number[][]
  color: string
  strokeWidth: number
  fill?: boolean
  text?: string
  id?: string
}

interface WhiteboardState {
  drawings: DrawingData[]
  currentDrawing: DrawingData | null
  tool: DrawingTool
  color: string
  strokeWidth: number
  backgroundImage?: string
}

interface Member {
  id: string
  name: string
  isModerator: boolean
  canDraw: boolean
  handRaised?: boolean
}

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "https://lazy-years-clean.loca.lt/"

// Emoji data for chat
const emojis = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👿', '👹', '👺', '🤡', '💩', '👻', '💀', '☠️', '👽', '👾', '🤖', '🎃', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾'
]

// Enhanced Whiteboard Component with All Fixes
const InteractiveWhiteboard: React.FC<{
  roomId: string
  socket: Socket | null
  isHost: boolean
  isVisible: boolean
  mode: WhiteboardMode
  onModeChange: (mode: WhiteboardMode) => void
  onClose: () => void
  darkMode: boolean
  canDraw: boolean
}> = ({ roomId, socket, isHost, isVisible, mode, onModeChange, onClose, darkMode, canDraw }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [startPos, setStartPos] = useState<{x: number, y: number} | null>(null)
  const [selectedElement, setSelectedElement] = useState<DrawingData | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [lastPanPoint, setLastPanPoint] = useState<{x: number, y: number} | null>(null)
  const [fillShapes, setFillShapes] = useState(false)

  const [whiteboardState, setWhiteboardState] = useState<WhiteboardState>({
    drawings: [],
    currentDrawing: null,
    tool: 'pen',
    color: '#000000',
    strokeWidth: 3
  })

  // Track received drawing IDs to prevent duplicates
  const receivedDrawingIds = useRef(new Set<string>())

  // Initialize canvas with proper device pixel ratio
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const resizeCanvas = () => {
      const rect = container.getBoundingClientRect()
      const scale = window.devicePixelRatio || 1
      
      canvas.width = rect.width * scale
      canvas.height = rect.height * scale
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.scale(scale, scale)
      }
      
      redrawCanvas()
    }

    resizeCanvas()
    const resizeObserver = new ResizeObserver(resizeCanvas)
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  // Socket listeners for whiteboard sync
  useEffect(() => {
    if (!socket) return

    const handleDrawing = (data: { drawing: DrawingData }) => {
      if (data.drawing.id && receivedDrawingIds.current.has(data.drawing.id)) {
        return
      }
      
      if (data.drawing.id) {
        receivedDrawingIds.current.add(data.drawing.id)
      }
      
      setWhiteboardState(prev => ({
        ...prev,
        drawings: [...prev.drawings, data.drawing]
      }))
    }

    const handleClear = () => {
      setWhiteboardState(prev => ({
        ...prev,
        drawings: [],
        currentDrawing: null,
        backgroundImage: undefined
      }))
      receivedDrawingIds.current.clear()
      setZoom(1)
      setPan({ x: 0, y: 0 })
    }

    const handleWhiteboardState = (data: { drawings: DrawingData[], background?: string }) => {
      setWhiteboardState(prev => ({
        ...prev,
        drawings: data.drawings,
        backgroundImage: data.background
      }))
      
      data.drawings.forEach(drawing => {
        if (drawing.id) {
          receivedDrawingIds.current.add(drawing.id)
        }
      })
    }

    const handleBackground = (data: { background: string }) => {
      setWhiteboardState(prev => ({
        ...prev,
        backgroundImage: data.background
      }))
    }

    socket.on('whiteboard:drawing', handleDrawing)
    socket.on('whiteboard:clear', handleClear)
    socket.on('whiteboard:state', handleWhiteboardState)
    socket.on('whiteboard:background', handleBackground)

    return () => {
      socket.off('whiteboard:drawing', handleDrawing)
      socket.off('whiteboard:clear', handleClear)
      socket.off('whiteboard:state', handleWhiteboardState)
      socket.off('whiteboard:background', handleBackground)
    }
  }, [socket])

  // Redraw all drawings with zoom and pan - NO GRID BACKGROUND
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    // Clear with white background - NO GRID
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Save context for transformations
    ctx.save()
    
    // Apply zoom and pan transformations
    const scale = window.devicePixelRatio || 1
    const width = ctx.canvas.width / scale
    const height = ctx.canvas.height / scale
    
    ctx.translate(pan.x, pan.y)
    ctx.scale(zoom, zoom)

    // Draw background image if exists
    if (whiteboardState.backgroundImage) {
      const img = new Image()
      img.onload = () => {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(img, 0, 0, width, height)
        drawAllShapes(ctx)
      }
      img.src = whiteboardState.backgroundImage
    } else {
      drawAllShapes(ctx)
    }

    ctx.restore()
  }, [whiteboardState.drawings, whiteboardState.currentDrawing, whiteboardState.backgroundImage, zoom, pan])

  const drawAllShapes = (ctx: CanvasRenderingContext2D) => {
    // NO GRID - Clean white background only

    // Redraw all saved drawings
    whiteboardState.drawings.forEach(drawing => {
      drawShape(ctx, drawing)
    })

    // Draw current active drawing
    if (whiteboardState.currentDrawing) {
      drawShape(ctx, whiteboardState.currentDrawing)
    }
  }

  useEffect(() => {
    redrawCanvas()
  }, [redrawCanvas])

  // Enhanced drawing functions - FIXED SHAPE FILLING
  const drawShape = (ctx: CanvasRenderingContext2D, drawing: DrawingData) => {
    ctx.strokeStyle = drawing.color
    ctx.fillStyle = drawing.color
    ctx.lineWidth = drawing.strokeWidth / zoom
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    const scale = window.devicePixelRatio || 1
    const scalePoints = (points: number[][]) => 
      points.map(([x, y]) => [x / scale, y / scale])

    const scaledPoints = scalePoints(drawing.points)

    switch (drawing.type) {
      case 'pen':
        if (scaledPoints.length > 1) {
          ctx.beginPath()
          ctx.moveTo(scaledPoints[0][0], scaledPoints[0][1])
          for (let i = 1; i < scaledPoints.length; i++) {
            ctx.lineTo(scaledPoints[i][0], scaledPoints[i][1])
          }
          ctx.stroke()
        }
        break

      case 'line':
        if (scaledPoints.length === 2) {
          ctx.beginPath()
          ctx.moveTo(scaledPoints[0][0], scaledPoints[0][1])
          ctx.lineTo(scaledPoints[1][0], scaledPoints[1][1])
          ctx.stroke()
        }
        break

      case 'rectangle':
        if (scaledPoints.length === 2) {
          const [start, end] = scaledPoints
          const width = end[0] - start[0]
          const height = end[1] - start[1]
          ctx.beginPath()
          ctx.rect(start[0], start[1], width, height)
          if (drawing.fill) {
            ctx.fill()
          }
          ctx.stroke()
        }
        break

      case 'circle':
        if (scaledPoints.length === 2) {
          const [start, end] = scaledPoints
          const radius = Math.sqrt(Math.pow(end[0] - start[0], 2) + Math.pow(end[1] - start[1], 2))
          ctx.beginPath()
          ctx.arc(start[0], start[1], radius, 0, 2 * Math.PI)
          if (drawing.fill) {
            ctx.fill()
          }
          ctx.stroke()
        }
        break

      case 'triangle':
        if (scaledPoints.length === 2) {
          const [start, end] = scaledPoints
          ctx.beginPath()
          ctx.moveTo(start[0] + (end[0] - start[0]) / 2, start[1])
          ctx.lineTo(end[0], end[1])
          ctx.lineTo(start[0], end[1])
          ctx.closePath()
          if (drawing.fill) {
            ctx.fill()
          }
          ctx.stroke()
        }
        break

      case 'arrow':
        if (scaledPoints.length === 2) {
          const [start, end] = scaledPoints
          const headLength = 15 / zoom
          const angle = Math.atan2(end[1] - start[1], end[0] - start[0])
          
          ctx.beginPath()
          ctx.moveTo(start[0], start[1])
          ctx.lineTo(end[0], end[1])
          ctx.stroke()
          
          // Arrow head
          ctx.beginPath()
          ctx.moveTo(end[0], end[1])
          ctx.lineTo(
            end[0] - headLength * Math.cos(angle - Math.PI / 6),
            end[1] - headLength * Math.sin(angle - Math.PI / 6)
          )
          ctx.lineTo(
            end[0] - headLength * Math.cos(angle + Math.PI / 6),
            end[1] - headLength * Math.sin(angle + Math.PI / 6)
          )
          ctx.closePath()
          ctx.fill()
        }
        break

      case 'text':
        if (drawing.text && scaledPoints.length === 1) {
          ctx.font = `bold ${(drawing.strokeWidth * 12) / zoom}px Arial`
          ctx.fillText(drawing.text, scaledPoints[0][0], scaledPoints[0][1])
        }
        break

      case 'eraser':
        if (scaledPoints.length > 1) {
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = (drawing.strokeWidth * 4) / zoom
          ctx.beginPath()
          ctx.moveTo(scaledPoints[0][0], scaledPoints[0][1])
          for (let i = 1; i < scaledPoints.length; i++) {
            ctx.lineTo(scaledPoints[i][0], scaledPoints[i][1])
          }
          ctx.stroke()
        }
        break
    }
  }

  // Get accurate mouse position with proper scaling and zoom
  const getMousePos = (e: React.MouseEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }

    const rect = canvas.getBoundingClientRect()
    const scale = window.devicePixelRatio || 1
    
    return {
      x: ((e.clientX - rect.left) * scale - pan.x) / zoom,
      y: ((e.clientY - rect.top) * scale - pan.y) / zoom
    }
  }

  // Mouse event handlers - FIXED DRAWING BOUNDARIES
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!canDraw || !isVisible) return

    const { x, y } = getMousePos(e)
    
    // Check if we're within canvas bounds
    const canvas = canvasRef.current
    if (!canvas) return
    
    const rect = canvas.getBoundingClientRect()
    if (e.clientX < rect.left || e.clientX > rect.right || 
        e.clientY < rect.top || e.clientY > rect.bottom) {
      return
    }
    
    if (whiteboardState.tool === 'select') {
      setIsPanning(true)
      setLastPanPoint({ x: e.clientX, y: e.clientY })
      return
    }

    setIsDrawing(true)
    setStartPos({ x, y })
    
    if (whiteboardState.tool === 'text') {
      const text = prompt('Enter text:')
      if (text) {
        const newDrawing: DrawingData = {
          type: 'text',
          points: [[x, y]],
          color: whiteboardState.color,
          strokeWidth: whiteboardState.strokeWidth,
          text: text,
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        }
        setWhiteboardState(prev => ({
          ...prev,
          drawings: [...prev.drawings, newDrawing]
        }))
        socket?.emit('whiteboard:drawing', { roomId, drawing: newDrawing })
      }
      setIsDrawing(false)
      setStartPos(null)
      return
    }

    const newDrawing: DrawingData = {
      type: whiteboardState.tool,
      points: [[x, y]],
      color: whiteboardState.tool === 'eraser' ? '#ffffff' : whiteboardState.color,
      strokeWidth: whiteboardState.tool === 'eraser' ? whiteboardState.strokeWidth * 3 : whiteboardState.strokeWidth,
      fill: fillShapes,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    }

    setWhiteboardState(prev => ({ ...prev, currentDrawing: newDrawing }))
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning && lastPanPoint) {
      const deltaX = e.clientX - lastPanPoint.x
      const deltaY = e.clientY - lastPanPoint.y
      setPan(prev => ({
        x: prev.x + deltaX,
        y: prev.y + deltaY
      }))
      setLastPanPoint({ x: e.clientX, y: e.clientY })
      return
    }

    if (!isDrawing || !canDraw || !whiteboardState.currentDrawing || !startPos) return

    const { x, y } = getMousePos(e)
    
    // Boundary check for drawing
    const canvas = canvasRef.current
    if (!canvas) return
    
    const rect = canvas.getBoundingClientRect()
    if (e.clientX < rect.left || e.clientX > rect.right || 
        e.clientY < rect.top || e.clientY > rect.bottom) {
      handleMouseUp()
      return
    }
    
    if (whiteboardState.tool === 'pen' || whiteboardState.tool === 'eraser') {
      const updatedDrawing = {
        ...whiteboardState.currentDrawing,
        points: [...whiteboardState.currentDrawing.points, [x, y]]
      }
      setWhiteboardState(prev => ({ ...prev, currentDrawing: updatedDrawing }))
    } else {
      const updatedDrawing = {
        ...whiteboardState.currentDrawing,
        points: [[startPos.x, startPos.y], [x, y]]
      }
      setWhiteboardState(prev => ({ ...prev, currentDrawing: updatedDrawing }))
    }
  }

  const handleMouseUp = () => {
    if (isPanning) {
      setIsPanning(false)
      setLastPanPoint(null)
      return
    }

    if (!isDrawing || !whiteboardState.currentDrawing) return

    setIsDrawing(false)
    setStartPos(null)
    
    if (whiteboardState.currentDrawing.points.length > 1 || whiteboardState.tool === 'text') {
      const finalDrawing = { 
        ...whiteboardState.currentDrawing,
        fill: fillShapes
      }
      setWhiteboardState(prev => ({
        ...prev,
        drawings: [...prev.drawings, finalDrawing],
        currentDrawing: null
      }))
      
      socket?.emit('whiteboard:drawing', { roomId, drawing: finalDrawing })
    } else {
      setWhiteboardState(prev => ({ ...prev, currentDrawing: null }))
    }
  }

  // Whiteboard actions
  const clearWhiteboard = () => {
    setWhiteboardState(prev => ({
      ...prev,
      drawings: [],
      currentDrawing: null,
      backgroundImage: undefined
    }))
    socket?.emit('whiteboard:clear', roomId)
    toast.success("Whiteboard cleared")
  }

  const downloadWhiteboard = () => {
    const canvas = canvasRef.current
    if (!canvas) return

    const link = document.createElement('a')
    link.download = `whiteboard-${roomId}-${Date.now()}.png`
    link.href = canvas.toDataURL()
    link.click()
    toast.success("Whiteboard saved")
  }

  const uploadBackgroundImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !canDraw) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const imageData = event.target?.result as string
      setWhiteboardState(prev => ({ ...prev, backgroundImage: imageData }))
      socket?.emit('whiteboard:background', { roomId, background: imageData })
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const zoomIn = () => {
    setZoom(prev => Math.min(prev + 0.25, 3))
  }

  const zoomOut = () => {
    setZoom(prev => Math.max(prev - 0.25, 0.25))
  }

  const resetZoom = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  const toggleFill = () => {
    setFillShapes(prev => !prev)
  }

  if (!isVisible) return null

  const colors = [
    '#000000', '#dc2626', '#059669', '#2563eb',
    '#ca8a04', '#9333ea', '#ea580c', '#475569',
    '#ffffff', '#fbbf24', '#60a5fa', '#c084fc'
  ]

  const tools: { id: DrawingTool; icon: React.ReactNode; label: string }[] = [
    { id: 'pen', icon: <Pencil size={18} />, label: 'Pen' },
    { id: 'line', icon: <Minimize2 size={18} />, label: 'Line' },
    { id: 'rectangle', icon: <Square size={18} />, label: 'Rectangle' },
    { id: 'circle', icon: <Circle size={18} />, label: 'Circle' },
    { id: 'triangle', icon: <Triangle size={18} />, label: 'Triangle' },
    { id: 'arrow', icon: <ArrowRight size={18} />, label: 'Arrow' },
    { id: 'text', icon: <Type size={18} />, label: 'Text' },
    { id: 'eraser', icon: <Eraser size={18} />, label: 'Eraser' },
    { id: 'select', icon: <Move size={18} />, label: 'Select & Pan' },
  ]

  return (
    <div className={cn(
      "bg-white border border-gray-200 rounded-xl shadow-lg flex flex-col transition-all duration-300",
      mode === 'split' ? "w-1/2 h-full" : "fixed inset-0 z-50"
    )}>
      {/* Whiteboard Header */}
      <div className="flex-shrink-0 p-3 border-b border-gray-200 bg-white rounded-t-xl">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold flex items-center gap-2 text-gray-800 text-sm">
                <Pencil size={16} className="text-blue-600" />
                Whiteboard {zoom !== 1 && `(${(zoom * 100).toFixed(0)}%)`}
              </h3>
              {!canDraw && (
                <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">View Only</span>
              )}
              {fillShapes && (
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">Fill On</span>
              )}
            </div>
            
            <div className="flex items-center gap-1">
              {canDraw && (
                <>
                  {/* Fill Toggle */}
                  <button
                    onClick={toggleFill}
                    className={cn(
                      "p-2 rounded-lg transition-colors",
                      fillShapes 
                        ? "bg-blue-100 text-blue-600" 
                        : "text-gray-600 hover:bg-gray-100"
                    )}
                    title={fillShapes ? "Disable Fill" : "Enable Fill"}
                  >
                    <Square size={16} className={fillShapes ? "fill-current" : ""} />
                  </button>

                  {/* Zoom Controls */}
                  <div className="flex items-center gap-1 mr-2 border-l border-gray-300 pl-2">
                    <button
                      onClick={zoomOut}
                      disabled={zoom <= 0.25}
                      className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
                      title="Zoom Out"
                    >
                      <ZoomOut size={16} />
                    </button>
                    <button
                      onClick={resetZoom}
                      className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                      title="Reset Zoom"
                    >
                      <RotateCcw size={16} />
                    </button>
                    <button
                      onClick={zoomIn}
                      disabled={zoom >= 3}
                      className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
                      title="Zoom In"
                    >
                      <ZoomIn size={16} />
                    </button>
                  </div>

                  <input
                    type="file"
                    accept="image/*"
                    onChange={uploadBackgroundImage}
                    className="hidden"
                    id="background-upload"
                  />
                  <label
                    htmlFor="background-upload"
                    className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors cursor-pointer"
                    title="Upload background image"
                  >
                    <ImageIcon size={16} />
                  </label>
                  <button
                    onClick={clearWhiteboard}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    title="Clear whiteboard"
                  >
                    <Trash2 size={16} />
                  </button>
                  <button
                    onClick={downloadWhiteboard}
                    className="p-2 text-green-600 hover:bg-green-50 rounded-lg transition-colors"
                    title="Save whiteboard"
                  >
                    <Download size={16} />
                  </button>
                </>
              )}
              <button
                onClick={() => onModeChange(mode === 'split' ? 'full' : 'split')}
                className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                {mode === 'split' ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
              </button>
              <button
                onClick={onClose}
                className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {canDraw && (
            <div className="flex flex-wrap gap-2">
              <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
                {tools.map(tool => (
                  <button
                    key={tool.id}
                    onClick={() => setWhiteboardState(prev => ({ ...prev, tool: tool.id }))}
                    className={cn(
                      "p-1.5 rounded-md transition-all duration-200 flex items-center gap-1",
                      whiteboardState.tool === tool.id 
                        ? "bg-blue-600 text-white shadow-sm" 
                        : "hover:bg-gray-200 text-gray-700"
                    )}
                    title={tool.label}
                  >
                    {tool.icon}
                    <span className="text-xs hidden sm:inline">{tool.label}</span>
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
                {colors.map(color => (
                  <button
                    key={color}
                    onClick={() => setWhiteboardState(prev => ({ ...prev, color }))}
                    className={cn(
                      "w-6 h-6 rounded-full border-2 transition-all transform hover:scale-110",
                      whiteboardState.color === color ? "border-blue-500 scale-110" : "border-gray-300",
                      color === '#ffffff' && 'border-gray-400'
                    )}
                    style={{ backgroundColor: color }}
                    title={color}
                  />
                ))}
              </div>

              <div className="flex items-center gap-2 bg-gray-100 rounded-lg px-3 py-1">
                <span className="text-xs text-gray-600">Size:</span>
                <input
                  type="range"
                  min="1"
                  max="20"
                  value={whiteboardState.strokeWidth}
                  onChange={(e) => setWhiteboardState(prev => ({ 
                    ...prev, 
                    strokeWidth: parseInt(e.target.value) 
                  }))}
                  className="w-20"
                />
                <span className="text-xs text-gray-600 w-4">{whiteboardState.strokeWidth}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Whiteboard Canvas - FULL AREA */}
      <div 
        ref={containerRef}
        className="flex-1 relative bg-white rounded-b-xl overflow-hidden min-h-0"
        style={mode === 'full' ? { height: 'calc(100vh - 80px)' } : {}}
      >
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          className={cn(
            "absolute inset-0 w-full h-full cursor-crosshair",
            canDraw ? (whiteboardState.tool === 'select' ? "cursor-grab" : "cursor-crosshair") : "cursor-not-allowed",
            isPanning && "cursor-grabbing"
          )}
        />
        
        {/* Drawing boundary indicator */}
        {isDrawing && (
          <div className="absolute inset-0 border-2 border-dashed border-blue-400 pointer-events-none"></div>
        )}
      </div>
    </div>
  )
}

// Enhanced Chat Component
const ChatPanel: React.FC<{
  messages: ChatMessage[]
  onSendMessage: (message: string) => void
  onFileUpload: (file: File) => void
  members: Member[]
  isOpen: boolean
  onClose: () => void
  currentUserId: string
}> = ({ messages, onSendMessage, onFileUpload, members, isOpen, onClose, currentUserId }) => {
  const [message, setMessage] = useState("")
  const [chatMode, setChatMode] = useState<ChatMode>('normal')
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (message.trim()) {
      onSendMessage(message.trim())
      setMessage("")
      setShowEmojiPicker(false)
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      // Check file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        toast.error("File size too large. Maximum 5MB allowed.")
        return
      }
      onFileUpload(file)
      e.target.value = ''
    }
  }

  const addEmoji = (emoji: string) => {
    setMessage(prev => prev + emoji)
    setShowEmojiPicker(false)
  }

  // Filter unique messages and mark as mine
  const processedMessages = messages.filter((msg, index, self) => 
    index === self.findIndex(m => m.id === msg.id)
  ).map(msg => ({
    ...msg,
    isMe: msg.senderId === currentUserId
  }))

  if (!isOpen) return null

  return (
    <div className={cn(
      "fixed right-4 bg-white border border-gray-200 rounded-xl shadow-lg flex flex-col z-40 transition-all duration-300",
      chatMode === 'normal' ? "top-20 bottom-20 w-80" : "inset-4"
    )}>
      <div className="flex-shrink-0 p-4 border-b border-gray-200 bg-gray-50 rounded-t-xl flex justify-between items-center">
        <h3 className="font-semibold text-gray-800 flex items-center gap-2">
          <MessageSquare size={18} className="text-blue-500" />
          Chat ({members.length})
        </h3>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setChatMode(chatMode === 'normal' ? 'full' : 'normal')}
            className="text-gray-500 hover:text-gray-700 transition-colors p-1 rounded hover:bg-gray-200"
          >
            {chatMode === 'normal' ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
          </button>
          <button 
            onClick={onClose} 
            className="text-gray-500 hover:text-gray-700 transition-colors p-1 rounded hover:bg-gray-200"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3" ref={chatScrollRef}>
        {processedMessages.length === 0 ? (
          <div className="text-center text-gray-500 mt-8">
            <MessageSquare size={32} className="mx-auto mb-2 opacity-50" />
            <p className="text-sm">No messages yet</p>
            <p className="text-xs text-gray-400">Start a conversation!</p>
          </div>
        ) : (
          processedMessages.map(msg => (
            <div 
              key={msg.id} 
              className={cn(
                "flex flex-col max-w-[85%] animate-in fade-in duration-200",
                msg.isMe ? "ml-auto items-end" : "mr-auto items-start"
              )}
            >
              {!msg.isMe && (
                <span className="text-xs text-gray-600 font-medium mb-1 px-1">
                  {msg.senderName}
                </span>
              )}
              <div className={cn(
                "px-3 py-2 rounded-lg text-sm break-words max-w-full",
                msg.isMe 
                  ? "bg-blue-600 text-white rounded-br-none" 
                  : "bg-gray-100 text-gray-800 rounded-bl-none"
              )}>
                {msg.type === 'text' ? (
                  <p className="whitespace-pre-wrap">{msg.text}</p>
                ) : (
                  <div className="max-w-full">
                    <img 
                      src={msg.fileData} 
                      alt="Shared file" 
                      className="max-w-full rounded max-h-48 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                      onClick={() => window.open(msg.fileData, '_blank')}
                    />
                  </div>
                )}
              </div>
              <span className="text-xs text-gray-500 mt-1 px-1">
                {msg.time}
              </span>
            </div>
          ))
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex-shrink-0 p-3 border-t border-gray-200 bg-gray-50 rounded-b-xl flex gap-2 relative">
        <input 
          type="file" 
          className="hidden" 
          ref={fileInputRef} 
          onChange={handleFileUpload} 
          accept="image/*, .pdf, .doc, .docx" 
        />
        
        <div className="flex gap-1">
          <button 
            type="button" 
            onClick={() => fileInputRef.current?.click()} 
            className="p-2 text-gray-500 hover:text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            title="Attach file"
          >
            <Paperclip size={16} />
          </button>
          <button 
            type="button"
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            className="p-2 text-gray-500 hover:text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            title="Add emoji"
          >
            <Smile size={16} />
          </button>
        </div>

        {showEmojiPicker && (
          <div className="absolute bottom-16 left-0 bg-white border border-gray-200 rounded-lg shadow-lg p-2 grid grid-cols-8 gap-1 max-h-40 overflow-y-auto z-50">
            {emojis.map(emoji => (
              <button
                key={emoji}
                type="button"
                onClick={() => addEmoji(emoji)}
                className="p-1 hover:bg-gray-100 rounded text-lg transition-colors"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}

        <input 
          className="flex-1 bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          placeholder="Type a message..." 
          value={message} 
          onChange={e => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSubmit(e)
            }
          }}
        />
        <button 
          type="submit" 
          className="bg-blue-600 p-2 rounded-lg text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
          disabled={!message.trim()}
          title="Send message"
        >
          <Send size={16} />
        </button>
      </form>
    </div>
  )
}

// Enhanced Participants Panel
const ParticipantsPanel: React.FC<{
  members: Member[]
  isHost: boolean
  isOpen: boolean
  onClose: () => void
  onAllowDrawing: (userId: string, allow: boolean) => void
  onMuteUser: (userId: string) => void
  onRemoveUser: (userId: string) => void
  onMakeHost: (userId: string) => void
  onLowerHand: (userId: string) => void
  onLowerAllHands: () => void
}> = ({ members, isHost, isOpen, onClose, onAllowDrawing, onMuteUser, onRemoveUser, onMakeHost, onLowerHand, onLowerAllHands }) => {
  const raisedHands = members.filter(m => m.handRaised)

  if (!isOpen) return null

  return (
    <div className="fixed left-4 top-20 bottom-20 w-80 bg-white border border-gray-200 rounded-xl shadow-lg flex flex-col z-40">
      <div className="flex-shrink-0 p-4 border-b border-gray-200 bg-gray-50 rounded-t-xl">
        <div className="flex justify-between items-center mb-2">
          <h3 className="font-semibold text-gray-800 flex items-center gap-2">
            <Users size={18} className="text-blue-500" />
            Participants ({members.length})
          </h3>
          <button 
            onClick={onClose} 
            className="text-gray-500 hover:text-gray-700 transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        
        {raisedHands.length > 0 && isHost && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-3">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm font-medium text-yellow-800 flex items-center gap-1">
                <Hand size={14} />
                Raised Hands ({raisedHands.length})
              </span>
              <button 
                onClick={onLowerAllHands}
                className="text-xs text-yellow-700 hover:text-yellow-900 underline"
              >
                Lower All
              </button>
            </div>
            {raisedHands.map(member => (
              <div key={member.id} className="flex justify-between items-center text-sm text-yellow-700">
                <span>{member.name}</span>
                <button 
                  onClick={() => onLowerHand(member.id)}
                  className="text-xs underline hover:text-yellow-900"
                >
                  Lower
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {members.map((member) => (
          <div 
            key={member.id} 
            className={cn(
              "flex items-center justify-between p-3 rounded-lg transition-colors group",
              member.isModerator ? "bg-yellow-50 border border-yellow-200" : 
              member.handRaised ? "bg-blue-50 border border-blue-200" : 
              "hover:bg-gray-50"
            )}
          >
            <div className="flex items-center gap-3">
              <div className={cn(
                "w-3 h-3 rounded-full",
                member.isModerator ? "bg-yellow-500" : 
                member.handRaised ? "bg-blue-500" : 
                "bg-green-500"
              )}></div>
              <div>
                <span className="font-medium text-sm flex items-center gap-1">
                  {member.name}
                  {member.isModerator && (
                    <Crown size={12} className="text-yellow-500" />
                  )}
                  {member.handRaised && (
                    <Hand size={12} className="text-blue-500" />
                  )}
                </span>
                <div className="flex gap-2 mt-1">
                  {member.canDraw && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">Can Draw</span>
                  )}
                  {member.isModerator && (
                    <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded">Host</span>
                  )}
                  {member.handRaised && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">Hand Raised</span>
                  )}
                </div>
              </div>
            </div>

            {isHost && !member.isModerator && (
              <DropdownMenu>
                <DropdownMenuTrigger className="p-1 hover:bg-gray-200 rounded transition-colors opacity-0 group-hover:opacity-100">
                  <MoreVertical size={16} />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="bg-white border border-gray-200 shadow-lg rounded-lg p-1 min-w-32">
                  <DropdownMenuItem 
                    onClick={() => onAllowDrawing(member.id, !member.canDraw)}
                    className="flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-gray-100 text-sm"
                  >
                    {member.canDraw ? <UserX size={14} /> : <UserCheck size={14} />}
                    {member.canDraw ? 'Revoke Drawing' : 'Allow Drawing'}
                  </DropdownMenuItem>
                  <DropdownMenuItem 
                    onClick={() => onMakeHost(member.id)}
                    className="flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-gray-100 text-sm"
                  >
                    <Crown size={14} />
                    Make Host
                  </DropdownMenuItem>
                  <DropdownMenuItem 
                    onClick={() => onMuteUser(member.id)}
                    className="flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-gray-100 text-sm"
                  >
                    <Mic size={14} />
                    Mute User
                  </DropdownMenuItem>
                  <DropdownMenuItem 
                    onClick={() => onRemoveUser(member.id)}
                    className="flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-red-50 text-red-600 text-sm"
                  >
                    <UserX size={14} />
                    Remove User
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// Main Meeting Component
const MeetingRoom: React.FC = () => {
  const router = useRouter()
  const pathname = usePathname()
  const { user } = useUser()
  const { useCallCallingState, useMicrophoneState, useCameraState } = useCallStateHooks()
  const callingState = useCallCallingState()
  const { microphone, isMute } = useMicrophoneState()
  const { camera, isEnabled: isCameraEnabled } = useCameraState()
  const call = useCall()

  // UI State
  const [layout, setLayout] = useState<CallLayoutType>('grid')
  const [showChat, setShowChat] = useState(false)
  const [showParticipants, setShowParticipants] = useState(false)
  const [darkMode, setDarkMode] = useState(false)
  const [showReactions, setShowReactions] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [controlsPinned, setControlsPinned] = useState(false)
  const [handRaised, setHandRaised] = useState(false)
  
  // Whiteboard State
  const [whiteboardEnabled, setWhiteboardEnabled] = useState(false)
  const [localShowWhiteboard, setLocalShowWhiteboard] = useState(false)
  const [localWhiteboardMode, setLocalWhiteboardMode] = useState<WhiteboardMode>('split')
  const [canDraw, setCanDraw] = useState(false)

  // Chat State
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState("")
  
  // Reactions State
  const [reactions, setReactions] = useState<Reaction[]>([])
  
  // Room State
  const [roomLocked, setRoomLocked] = useState(false)
  const [members, setMembers] = useState<Member[]>([])
  const [hostId, setHostId] = useState<string | null>(null)
  const [passwordRequired, setPasswordRequired] = useState(false)
  const [passwordInput, setPasswordInput] = useState("")
  const [connectionError, setConnectionError] = useState<string | null>(null)

  // Refs
  const socketRef = useRef<Socket | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // const controlsTimeoutRef = useRef<NodeJS.Timeout>()
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const receivedReactionIds = useRef(new Set<string>())
  const receivedMessageIds = useRef(new Set<string>())

  const meetingId = (pathname?.split('/').pop() || 'default-room')
  const isHost = !!(hostId && user && user.id === hostId)

  // Dark mode effect
  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [darkMode])

  // Fixed Auto-hide controls
  useEffect(() => {
    if (controlsPinned) {
      setControlsVisible(true)
      return
    }

    const handleMouseMove = () => {
      setControlsVisible(true)
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
      }
      controlsTimeoutRef.current = setTimeout(() => {
        setControlsVisible(false)
      }, 3000)
    }

    const handleMouseEnter = () => {
      setControlsVisible(true)
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
      }
    }

    const handleMouseLeave = () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
      }
      controlsTimeoutRef.current = setTimeout(() => {
        setControlsVisible(false)
      }, 1000)
    }

    // Initial show
    handleMouseMove()

    const controlsElement = document.querySelector('.meeting-controls')
    if (controlsElement) {
      controlsElement.addEventListener('mouseenter', handleMouseEnter)
      controlsElement.addEventListener('mouseleave', handleMouseLeave)
    }

    window.addEventListener('mousemove', handleMouseMove)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      if (controlsElement) {
        controlsElement.removeEventListener('mouseenter', handleMouseEnter)
        controlsElement.removeEventListener('mouseleave', handleMouseLeave)
      }
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
      }
    }
  }, [controlsPinned])

  // Socket Connection
  useEffect(() => {
    if (!user || !meetingId) return

    const socket = io(SOCKET_URL, {
      auth: { 
        userId: user.id, 
        userName: user.firstName || user.username || 'User' 
      },
      transports: ['websocket', 'polling'],
    })

    socketRef.current = socket

    socket.on('connect', () => {
      console.log('Connected to server')
      socket.emit('join-room', { 
        roomId: meetingId, 
        userId: user.id,
        userName: user.firstName || user.username || 'User'
      })
      setConnectionError(null)
    })

    socket.on('connect_error', (error) => {
      console.error('Connection error:', error)
      setConnectionError('Failed to connect to server')
    })

    socket.on('room-state', (state: any) => {
      setRoomLocked(state.locked)
      setHostId(state.hostId)
      setMembers(state.members || [])
      setCanDraw(state.canDraw || false)
      
      if (state.hostId === user.id && !state.canDraw) {
        setCanDraw(true)
      }
    })

    socket.on('room:locked', () => {
      setRoomLocked(true)
      toast.warning('Room has been locked')
    })

    socket.on('room:unlocked', () => {
      setRoomLocked(false)
      toast.success('Room has been unlocked')
    })

    socket.on('error:password-required', () => {
      setPasswordRequired(true)
    })

    socket.on('chat:receive', (msg: ChatMessage) => {
      // Prevent duplicate messages
      if (receivedMessageIds.current.has(msg.id)) {
        return
      }
      receivedMessageIds.current.add(msg.id)
      
      // Add message to state - let the ChatPanel handle isMe
      setMessages(prev => [...prev, msg])
      
      // Show notification for new messages when chat is closed
      if (!showChat && msg.senderId !== user.id) {
        toast.info(`New message from ${msg.senderName}`)
      }
    })

    socket.on('reaction:send', (reaction: Reaction) => {
      if (receivedReactionIds.current.has(reaction.id)) {
        return
      }
      receivedReactionIds.current.add(reaction.id)
      
      setReactions(prev => [...prev, reaction])
      setTimeout(() => {
        setReactions(prev => prev.filter(r => r.id !== reaction.id))
        receivedReactionIds.current.delete(reaction.id)
      }, 3000)
    })

    socket.on('whiteboard:enable', () => {
      setWhiteboardEnabled(true)
      setLocalShowWhiteboard(true)
      toast.success('Whiteboard enabled by host')
    })

    socket.on('whiteboard:disable', () => {
      setWhiteboardEnabled(false)
      setLocalShowWhiteboard(false)
      toast.info('Whiteboard disabled by host')
    })

    socket.on('whiteboard:user-permission', (data: { userId: string, canDraw: boolean }) => {
      if (data.userId === user.id) {
        setCanDraw(data.canDraw)
        toast.info(data.canDraw ? 'You can now draw on whiteboard' : 'Whiteboard drawing disabled')
      }
      setMembers(prev => prev.map(member => 
        member.id === data.userId ? { ...member, canDraw: data.canDraw } : member
      ))
    })

    socket.on('room-members', (members: Member[]) => {
      setMembers(members)
    })

    socket.on('host:changed', (data: { newHostId: string }) => {
      setHostId(data.newHostId)
      if (data.newHostId === user.id) {
        toast.success('You are now the host')
        setCanDraw(true)
      }
    })

    socket.on('hand:raised', (data: { userId: string, userName: string }) => {
      setMembers(prev => prev.map(member => 
        member.id === data.userId ? { ...member, handRaised: true } : member
      ))
      if (isHost && data.userId !== user.id) {
        toast.info(`${data.userName} raised their hand`)
      }
    })

    socket.on('hand:lowered', (data: { userId: string }) => {
      setMembers(prev => prev.map(member => 
        member.id === data.userId ? { ...member, handRaised: false } : member
      ))
    })

    socket.on('hand:lowered-all', () => {
      setMembers(prev => prev.map(member => ({ ...member, handRaised: false })))
      setHandRaised(false)
    })

    socket.on('moderator:force-mute', () => {
      if (microphone) {
        microphone.disable()
        toast.warning('You have been muted by the host')
      }
    })

    socket.on('moderator:force-leave', () => {
      toast.error('You have been removed from the meeting')
      router.push('/')
    })

    return () => {
      socket.disconnect()
    }
  }, [meetingId, user, microphone, router, isHost])

  // Handlers
  const submitPassword = () => {
    if (!passwordInput.trim()) {
      toast.error("Please enter a password")
      return
    }
    socketRef.current?.emit('join-room', { 
      roomId: meetingId, 
      userId: user?.id, 
      password: passwordInput 
    })
  }

  const toggleLock = () => {
    if (!isHost) {
      toast.error("Only host can lock/unlock room")
      return
    }

    if (roomLocked) {
      socketRef.current?.emit('room:unlock', meetingId)
      toast.success("Room unlocked")
    } else {
      const pwd = prompt("Set room password:")
      if (pwd && pwd.trim()) {
        socketRef.current?.emit('room:lock', { 
          roomId: meetingId, 
          password: pwd.trim() 
        })
        toast.success("Room locked with password")
      }
    }
  }

  const handleSendMessage = (message: string) => {
    if (!user) return
    
    const msg: ChatMessage = { 
      id: `${user.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      senderId: user.id,
      senderName: user.firstName || user.username || 'User', 
      text: message, 
      type: 'text',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
    }
    
    // Add message locally immediately for better UX
    setMessages(prev => [...prev, msg])
    socketRef.current?.emit('chat:send', { roomId: meetingId, message: msg })
  }

  const handleFileUpload = (file: File) => {
    if (!user) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const msg: ChatMessage = {
        id: `${user.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        senderId: user.id,
        senderName: user.firstName || user.username || 'User',
        type: 'file',
        fileData: event.target?.result as string,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
      
      setMessages(prev => [...prev, msg])
      socketRef.current?.emit('chat:send', { roomId: meetingId, message: msg })
    }
    reader.readAsDataURL(file)
  }

  const sendReaction = (type: ReactionType) => {
    if (!user) return
    
    const reaction: Reaction = {
      id: `${user.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      senderId: user.id,
      senderName: user.firstName || user.username || 'User',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    
    socketRef.current?.emit('reaction:send', { roomId: meetingId, reaction })
    setShowReactions(false)
  }

  const toggleHandRaise = () => {
    if (!user) return
    
    if (handRaised) {
      socketRef.current?.emit('hand:lower', meetingId)
      setHandRaised(false)
    } else {
      socketRef.current?.emit('hand:raise', meetingId)
      setHandRaised(true)
      toast.info("Hand raised")
    }
  }

  const toggleWhiteboard = () => {
    if (isHost) {
      const newState = !whiteboardEnabled
      setWhiteboardEnabled(newState)
      setLocalShowWhiteboard(newState)
      socketRef.current?.emit(newState ? 'whiteboard:enable' : 'whiteboard:disable', meetingId)
      
      if (newState) {
        toast.success("Whiteboard enabled for all participants")
      } else {
        toast.info("Whiteboard disabled for all participants")
      }
    } else {
      if (!whiteboardEnabled) {
        toast.warning("Whiteboard is not enabled by host")
        return
      }
      setLocalShowWhiteboard(!localShowWhiteboard)
    }
  }

  const toggleMicrophone = async () => {
    try {
      if (microphone) {
        await microphone.toggle()
      }
    } catch (error) {
      console.error('Microphone error:', error)
      toast.error('Failed to toggle microphone')
    }
  }

  const toggleCamera = async () => {
    try {
      if (camera) {
        await camera.toggle()
      }
    } catch (error) {
      console.error('Camera error:', error)
      toast.error('Failed to toggle camera')
    }
  }

  const handleAllowDrawing = (userId: string, allow: boolean) => {
    socketRef.current?.emit('whiteboard:allow-user', { roomId: meetingId, userId, allow })
  }

  const handleMakeHost = (userId: string) => {
    socketRef.current?.emit('host:make-host', { roomId: meetingId, userId })
  }

  const handleMuteUser = (userId: string) => {
    socketRef.current?.emit('moderator:mute-user', { roomId: meetingId, userId })
  }

  const handleRemoveUser = (userId: string) => {
    socketRef.current?.emit('moderator:remove-user', { roomId: meetingId, userId })
  }

  const handleLowerHand = (userId: string) => {
    socketRef.current?.emit('hand:lower', meetingId)
  }

  const handleLowerAllHands = () => {
    socketRef.current?.emit('hand:lower-all', meetingId)
  }

  const handleLeaveRoom = () => {
    socketRef.current?.disconnect()
    router.push('/')
    toast.success("Left the meeting")
  }

  if (!user) return <Loading />
  if (callingState !== CallingState.JOINED) return <Loading />

  if (passwordRequired) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="bg-white dark:bg-gray-800 p-8 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-2xl text-center space-y-6 max-w-md w-full mx-4">
          <Lock size={48} className="mx-auto text-red-500" />
          <h2 className="text-2xl font-bold text-gray-800 dark:text-white">Room Locked</h2>
          <p className="text-gray-600 dark:text-gray-300">Enter the password to join this meeting</p>
          <input 
            type="password" 
            value={passwordInput} 
            onChange={e => setPasswordInput(e.target.value)} 
            className="w-full bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-3 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Enter password"
            onKeyPress={(e) => e.key === 'Enter' && submitPassword()}
          />
          <Button 
            onClick={submitPassword} 
            className="w-full bg-blue-600 hover:bg-blue-700 transition-colors py-3 text-lg"
            disabled={!passwordInput.trim()}
          >
            Join Meeting
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={cn(
      "min-h-screen bg-gray-50 transition-colors duration-200",
      darkMode && "dark bg-gray-900"
    )}>
      {/* Connection Status */}
      {connectionError && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-red-500 text-white px-6 py-3 rounded-full flex items-center gap-3 shadow-lg">
          <AlertCircle size={20} />
          <span>{connectionError}</span>
        </div>
      )}

      {/* Reactions */}
      {reactions.map(reaction => (
        <div 
          key={reaction.id}
          className="fixed animate-bounce text-3xl z-50 pointer-events-none"
          style={{
            top: `${Math.random() * 70 + 15}%`,
            left: `${Math.random() * 70 + 15}%`,
          }}
        >
          {reaction.type === 'hand' && <Hand className="text-yellow-500" />}
          {reaction.type === 'thumbs-up' && <ThumbsUp className="text-green-500" />}
          {reaction.type === 'heart' && <Heart className="text-red-500" />}
          {reaction.type === 'star' && <Star className="text-yellow-400" />}
          {reaction.type === 'message' && <MessageCircle className="text-blue-500" />}
        </div>
      ))}

      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-3">
          <Button 
            onClick={() => {
              navigator.clipboard.writeText(window.location.href)
              toast.success("Meeting link copied!")
            }}
            className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2"
          >
            <Share2 size={16} className="mr-2" />
            Share
          </Button>

          <div className={cn(
            "flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium",
            roomLocked 
              ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300" 
              : "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
          )}>
            {roomLocked ? <Lock size={14} /> : <LockOpen size={14} />}
            <span>{roomLocked ? 'Locked' : 'Open'}</span>
          </div>

          {isHost && (
            <div className="flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300">
              <Crown size={14} />
              <span>Host</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={toggleLock}
            disabled={!isHost}
            className={cn(
              "rounded-lg px-4 py-2",
              isHost 
                ? "bg-gray-600 hover:bg-gray-700 text-white" 
                : "bg-gray-300 text-gray-500 cursor-not-allowed dark:bg-gray-600 dark:text-gray-400"
            )}
          >
            {roomLocked ? 'Unlock' : 'Lock'}
          </Button>

          <Button
            onClick={() => setDarkMode(!darkMode)}
            className="bg-gray-600 hover:bg-gray-700 text-white rounded-lg p-2"
          >
            {darkMode ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className={cn(
        "flex transition-all duration-300 p-4 gap-4",
        localShowWhiteboard ? "h-[calc(100vh-140px)]" : "h-[calc(100vh-120px)]"
      )}>
        {/* Video Area */}
        <div className={cn(
          "bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden transition-all duration-300",
          localShowWhiteboard && localWhiteboardMode === 'split' ? "flex-1" : "w-full",
          localShowWhiteboard && localWhiteboardMode === 'full' && 'hidden'
        )}>
          {layout === 'grid' ? (
            <PaginatedGridLayout />
          ) : (
            <SpeakerLayout 
              participantsBarPosition={layout === 'speaker-left' ? 'right' : 'left'} 
            />
          )}
        </div>

        {/* Whiteboard */}
        {localShowWhiteboard && (
          <InteractiveWhiteboard
            roomId={meetingId}
            socket={socketRef.current}
            isHost={isHost}
            isVisible={localShowWhiteboard}
            mode={localWhiteboardMode}
            onModeChange={setLocalWhiteboardMode}
            onClose={() => setLocalShowWhiteboard(false)}
            darkMode={darkMode}
            canDraw={canDraw}
          />
        )}
      </div>

      {/* Enhanced Controls - Fixed auto-hide */}
      <div className={cn(
        "meeting-controls fixed left-1/2 -translate-x-1/2 z-30 transition-all duration-500 ease-in-out",
        controlsVisible ? "bottom-4 opacity-100" : "bottom-0 opacity-0 -translate-y-4"
      )}>
        <div className="relative">
          <button
            onClick={() => setControlsPinned(!controlsPinned)}
            className={cn(
              "absolute -top-8 left-1/2 -translate-x-1/2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-t-lg px-3 py-1 text-sm transition-colors",
              controlsPinned 
                ? "text-blue-600 border-blue-200" 
                : "text-gray-500 hover:text-gray-700"
            )}
          >
            {controlsPinned ? 'Pinned' : 'Pin'}
          </button>
          <div className="flex items-center gap-3 bg-white dark:bg-gray-800 px-6 py-3 rounded-xl border border-gray-200 dark:border-gray-700 shadow-lg">
            {/* Audio Control */}
            <button
              onClick={toggleMicrophone}
              className={cn(
                "p-3 rounded-lg transition-all duration-200",
                isMute
                  ? "bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-300" 
                  : "bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-300"
              )}
            >
              <Mic size={20} />
            </button>

            {/* Video Control */}
            <button
              onClick={toggleCamera}
              className={cn(
                "p-3 rounded-lg transition-all duration-200",
                isCameraEnabled
                  ? "bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-300" 
                  : "bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-300"
              )}
            >
              <Video size={20} />
            </button>

            {/* Hand Raise */}
            <button
              onClick={toggleHandRaise}
              className={cn(
                "p-3 rounded-lg transition-all duration-200",
                handRaised
                  ? "bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300" 
                  : "bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300"
              )}
            >
              <Hand size={20} />
            </button>

            <div className="w-px h-8 bg-gray-300 dark:bg-gray-600 mx-1" />
            
            {/* Stream IO Call Controls */}
            <CallControls onLeave={handleLeaveRoom} />
            
            <div className="w-px h-8 bg-gray-300 dark:bg-gray-600 mx-1" />
            
            {/* Layout */}
            <DropdownMenu>
              <DropdownMenuTrigger className="p-3 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-all duration-200">
                <LayoutList size={20} />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-lg rounded-lg">
                <DropdownMenuItem onClick={() => setLayout('grid')} className="cursor-pointer">
                  Grid View
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLayout('speaker-left')} className="cursor-pointer">
                  Speaker Left
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLayout('speaker-right')} className="cursor-pointer">
                  Speaker Right
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Whiteboard */}
            <button
              onClick={toggleWhiteboard}
              className={cn(
                "p-3 rounded-lg transition-all duration-200",
                localShowWhiteboard
                  ? "bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300" 
                  : "bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300"
              )}
            >
              <Pencil size={20} />
            </button>

            {/* Participants */}
            <button
              onClick={() => setShowParticipants(!showParticipants)}
              className={cn(
                "p-3 rounded-lg transition-all duration-200 relative",
                showParticipants
                  ? "bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300" 
                  : "bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300"
              )}
            >
              <Users size={20} />
              {members.length > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
                  {members.length}
                </span>
              )}
            </button>

            {/* Chat */}
            <button
              onClick={() => setShowChat(!showChat)}
              className={cn(
                "p-3 rounded-lg transition-all duration-200 relative",
                showChat
                  ? "bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300" 
                  : "bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300"
              )}
            >
              <MessageSquare size={20} />
              {messages.filter(m => !m.isMe).length > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
                  {messages.filter(m => !m.isMe).length}
                </span>
              )}
            </button>

            {/* Reactions */}
            <button
              onClick={() => setShowReactions(!showReactions)}
              className="p-3 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-all duration-200 text-gray-700 dark:text-gray-300"
            >
              <Smile size={20} />
            </button>
          </div>
        </div>
      </div>

      {/* Chat Panel */}
      <ChatPanel
        messages={messages}
        onSendMessage={handleSendMessage}
        onFileUpload={handleFileUpload}
        members={members}
        isOpen={showChat}
        onClose={() => setShowChat(false)}
        currentUserId={user?.id || ''}
      />

      {/* Participants Panel */}
      <ParticipantsPanel
        members={members}
        isHost={isHost}
        isOpen={showParticipants}
        onClose={() => setShowParticipants(false)}
        onAllowDrawing={handleAllowDrawing}
        onMuteUser={handleMuteUser}
        onRemoveUser={handleRemoveUser}
        onMakeHost={handleMakeHost}
        onLowerHand={handleLowerHand}
        onLowerAllHands={handleLowerAllHands}
      />

      {/* Reactions Popup */}
      {showReactions && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-3 flex gap-2 shadow-lg">
          {[
            { type: 'hand' as ReactionType, icon: <Hand size={22} className="text-yellow-500" />, label: 'Raise Hand' },
            { type: 'thumbs-up' as ReactionType, icon: <ThumbsUp size={22} className="text-green-500" />, label: 'Thumbs Up' },
            { type: 'heart' as ReactionType, icon: <Heart size={22} className="text-red-500" />, label: 'Heart' },
            { type: 'star' as ReactionType, icon: <Star size={22} className="text-yellow-400" />, label: 'Star' },
            { type: 'message' as ReactionType, icon: <MessageCircle size={22} className="text-blue-500" />, label: 'Message' },
          ].map((reaction) => (
            <button
              key={reaction.type}
              onClick={() => sendReaction(reaction.type)}
              className="p-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-all duration-200 hover:scale-110"
              title={reaction.label}
            >
              {reaction.icon}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default MeetingRoom
