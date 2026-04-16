import { Canvas, useFrame, useLoader } from '@react-three/fiber'
import { CameraControls, Center, Environment } from '@react-three/drei'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js'

type LodKey = 'ultralow' | 'low' | 'mid' | 'high' | 'full'
type PartialLods = Partial<Record<LodKey, THREE.BufferGeometry>> & { ultralow: THREE.BufferGeometry }

function LODCell({ lods, center, material }: {
  lods: PartialLods
  center: THREE.Vector3
  material: THREE.ShaderMaterial
}) {
  const meshRef = useRef<THREE.Points>(null)
  const activeLodRef = useRef<LodKey>('ultralow')
  const prevDist = useRef(Infinity)

  // When higher LODs arrive (lods object reference changes), force re-evaluation
  // on the very next frame so the current camera position immediately upgrades.
  useEffect(() => {
    prevDist.current = Infinity
  }, [lods])

  useFrame(({ camera }) => {
    const dist = camera.position.distanceTo(center)
    if (Math.abs(dist - prevDist.current) < 0.3) return
    prevDist.current = dist

    const next: LodKey = dist > 80 ? 'ultralow'
                       : dist > 50 ? 'low'
                       : dist > 24 ? 'mid'
                       : dist > 10 ? 'high'
                       : 'full'

    if (next !== activeLodRef.current) {
      activeLodRef.current = next
      if (meshRef.current) {
        // Fall back to ultralow if the desired LOD isn't built yet
        meshRef.current.geometry = lods[next] ?? lods['ultralow']
      }
    }
  })

  return <points ref={meshRef} geometry={lods['ultralow']} material={material} />
}

type CellData = { lods: PartialLods; center: THREE.Vector3 }

function LODPointCloud({ baseGeometry }: { baseGeometry: THREE.BufferGeometry }) {
  const [cells, setCells] = useState<CellData[] | null>(null)
  // Mutable ref so the phase-2 handler can update lods without a stale closure
  const cellsRef = useRef<CellData[] | null>(null)
  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexColors: true,
    uniforms: {
      // World-space radius of each point disc. Tune this to match your cloud's
      // point spacing — larger value = bigger discs = more solid surface.
      pointSize:  { value: 0.05 },
      // Physical screen height in px, updated every frame so perspective
      // projection stays correct after window resize.
      resolution: { value: 900 },
    },
    vertexShader: `
      varying vec3 vColor;
      uniform float pointSize;
      uniform float resolution;
      void main() {
        vColor = color;
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        // Project world-space radius to screen pixels via perspective.
        // depth (-mvPos.z) is used for correct perspective projection.
        // sparsityScale is based on spherical distance so it stays uniform
        // across a surface at any view angle, avoiding density gradients.
        float depth = max(0.001, -mvPos.z);
        float dist = length(mvPos.xyz);
        float sparsityScale = clamp(sqrt(dist / 5.0), 1.0, 4.0);
        gl_PointSize = max(2.0, pointSize * projectionMatrix[1][1] * resolution * 0.5 / depth * sparsityScale);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        vec2 uv = gl_PointCoord * 2.0 - 1.0;
        float r = dot(uv, uv);
        if (r > 1.0) discard;
        vec3 normal = normalize(vec3(uv, sqrt(1.0 - r)));
        vec3 light = normalize(vec3(1.0, 2.0, 1.0));
        float diffuse = max(dot(normal, light), 0.0);
        float ambient = 0.3;
        gl_FragColor = vec4(vColor * (ambient + diffuse * 0.7), 1.0);
      }
    `,
  }), [])

  useEffect(() => {
    return () => { material.dispose() }
  }, [material])

  useEffect(() => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

    const pos = baseGeometry.getAttribute('position').array as Float32Array
    const col = baseGeometry.getAttribute('color').array as Float32Array

    // clone before transferring — PCDLoader still owns the originals
    const posCopy = pos.slice()
    const colCopy = col.slice()
    worker.postMessage(
      { positions: posCopy, colors: colCopy },
      [posCopy.buffer, colCopy.buffer]
    )

    worker.onmessage = (e) => {
      const msg = e.data

      if (msg.phase === 'ultralow') {
        // Phase 1: show the cloud immediately at 10% density
        const phase1 = msg.cells as Array<{
          center: [number, number, number]
          ultralow: { positions: Float32Array, colors: Float32Array }
        }>
        const newCells: CellData[] = phase1.map(cell => ({
          center: new THREE.Vector3(...cell.center),
          lods: { ultralow: makeGeometry(cell.ultralow.positions, cell.ultralow.colors) },
        }))
        cellsRef.current = newCells
        setCells(newCells)
      } else if (msg.phase === 'higher') {
        // Phase 2: upgrade each cell with denser LODs, giving each a new lods
        // object reference so LODCell's useEffect resets its distance check.
        const phase2 = msg.cells as Array<{
          low:  { positions: Float32Array, colors: Float32Array }
          mid:  { positions: Float32Array, colors: Float32Array }
          high: { positions: Float32Array, colors: Float32Array }
          full: { positions: Float32Array, colors: Float32Array }
        }>
        const existing = cellsRef.current
        if (!existing) return
        const upgraded: CellData[] = existing.map((cell, i) => ({
          center: cell.center,
          lods: {
            ...cell.lods,
            low:  makeGeometry(phase2[i]!.low.positions,  phase2[i]!.low.colors),
            mid:  makeGeometry(phase2[i]!.mid.positions,  phase2[i]!.mid.colors),
            high: makeGeometry(phase2[i]!.high.positions, phase2[i]!.high.colors),
            full: makeGeometry(phase2[i]!.full.positions, phase2[i]!.full.colors),
          },
        }))
        cellsRef.current = upgraded
        setCells(upgraded)
        worker.terminate()
      }
    }

    return () => {
      worker.terminate()
      // Dispose all geometries across both phases
      if (cellsRef.current) {
        for (const cell of cellsRef.current) {
          for (const geo of Object.values(cell.lods)) {
            (geo as THREE.BufferGeometry).dispose()
          }
        }
        cellsRef.current = null
      }
    }
  }, [baseGeometry])

  useFrame(({ gl }) => {
    material.uniforms.resolution.value = gl.domElement.height
  })

  if (!cells) return null  // still processing in worker

  return (
    <>
      {cells.map((cell, i) => (
        <LODCell key={i} lods={cell.lods} center={cell.center} material={material} />
      ))}
    </>
  )
}

function makeGeometry(positions: Float32Array, colors: Float32Array) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geo
}


type HoldHandlers = {
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>
  onPointerUp: React.PointerEventHandler<HTMLButtonElement>
  onPointerCancel: React.PointerEventHandler<HTMLButtonElement>
  onPointerLeave: React.PointerEventHandler<HTMLButtonElement>
  onContextMenu: React.MouseEventHandler<HTMLButtonElement>
}

function useHoldAction(action: (dtSeconds: number) => void): HoldHandlers {
  const rafIdRef = useRef<number | null>(null)
  const lastTRef = useRef<number | null>(null)
  const holdingRef = useRef(false)

  const stop = useCallback(() => {
    holdingRef.current = false
    lastTRef.current = null
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
  }, [])

  const loop = useCallback(
    (t: number) => {
      if (!holdingRef.current) return
      const last = lastTRef.current ?? t
      const dt = Math.min(0.05, Math.max(0, (t - last) / 1000))
      lastTRef.current = t
      action(dt)
      rafIdRef.current = requestAnimationFrame(loop)
    },
    [action],
  )

  const start = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      holdingRef.current = true
      if (rafIdRef.current == null) {
        rafIdRef.current = requestAnimationFrame(loop)
      }
    },
    [loop],
  )

  useEffect(() => {
    const onUp = () => stop()
    window.addEventListener('pointerup', onUp, { passive: true })
    window.addEventListener('pointercancel', onUp, { passive: true })
    window.addEventListener('blur', onUp)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      stop()
    }
  }, [stop])

  return {
    onPointerDown: start,
    onPointerUp: stop,
    onPointerCancel: stop,
    onPointerLeave: stop,
    onContextMenu: (e) => e.preventDefault(),
  }
}

type JoystickHandlers = {
  onPointerDown: React.PointerEventHandler<HTMLDivElement>
  onPointerMove: React.PointerEventHandler<HTMLDivElement>
  onPointerUp: React.PointerEventHandler<HTMLDivElement>
  onPointerCancel: React.PointerEventHandler<HTMLDivElement>
  onPointerLeave: React.PointerEventHandler<HTMLDivElement>
  onContextMenu: React.MouseEventHandler<HTMLDivElement>
}

function useJoystickAction(
  action: (dtSeconds: number, x: number, y: number) => void,
): {
  handlers: JoystickHandlers
  knob: { x: number; y: number; active: boolean }
} {
  const rafIdRef = useRef<number | null>(null)
  const lastTRef = useRef<number | null>(null)
  const holdingRef = useRef(false)
  const pointerIdRef = useRef<number | null>(null)
  const baseRef = useRef<{ x: number; y: number } | null>(null)
  const vecRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const [knob, setKnob] = useState<{ x: number; y: number; active: boolean }>({
    x: 0,
    y: 0,
    active: false,
  })

  const stop = useCallback(() => {
    holdingRef.current = false
    pointerIdRef.current = null
    baseRef.current = null
    vecRef.current = { x: 0, y: 0 }
    setKnob({ x: 0, y: 0, active: false })
    lastTRef.current = null
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
  }, [])

  const loop = useCallback(
    (t: number) => {
      if (!holdingRef.current) return
      const last = lastTRef.current ?? t
      const dt = Math.min(0.05, Math.max(0, (t - last) / 1000))
      lastTRef.current = t
      const v = vecRef.current
      action(dt, v.x, v.y)
      rafIdRef.current = requestAnimationFrame(loop)
    },
    [action],
  )

  const updateFromEvent = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!holdingRef.current) return
    if (pointerIdRef.current != null && e.pointerId !== pointerIdRef.current) return
    const base = baseRef.current
    if (!base) return

    const dx = e.clientX - base.x
    const dy = e.clientY - base.y
    const radius = 28
    const mag = Math.hypot(dx, dy)
    const clamped = mag > radius && mag > 0 ? radius / mag : 1
    const nx = (dx * clamped) / radius
    const ny = (dy * clamped) / radius
    const dead = 0.12
    const fx = Math.abs(nx) < dead ? 0 : nx
    const fy = Math.abs(ny) < dead ? 0 : ny
    vecRef.current = { x: fx, y: fy }
    setKnob({ x: nx, y: ny, active: true })
  }, [])

  useEffect(() => {
    const onUp = () => stop()
    window.addEventListener('pointerup', onUp, { passive: true })
    window.addEventListener('pointercancel', onUp, { passive: true })
    window.addEventListener('blur', onUp)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      stop()
    }
  }, [stop])

  const handlers: JoystickHandlers = {
    onPointerDown: (e) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      pointerIdRef.current = e.pointerId
      baseRef.current = { x: e.clientX, y: e.clientY }
      holdingRef.current = true
      setKnob((k) => ({ ...k, active: true }))
      updateFromEvent(e)
      if (rafIdRef.current == null) rafIdRef.current = requestAnimationFrame(loop)
    },
    onPointerMove: (e) => {
      e.preventDefault()
      updateFromEvent(e)
    },
    onPointerUp: () => stop(),
    onPointerCancel: () => stop(),
    onPointerLeave: () => stop(),
    onContextMenu: (e) => e.preventDefault(),
  }

  return { handlers, knob }
}

function MeshModel() {
  const gltf = useLoader(GLTFLoader, '/mesh.glb')
  return (
    <Center>
      <primitive object={gltf.scene} />
    </Center>
  )
}

function PointCloud({ mode }: { mode: 'raw' | 'lod' }) {
  const points = useLoader(PCDLoader, '/pointcloud.pcd')

  const material = points.material as THREE.PointsMaterial
  if (material) {
    material.size = 0.05
    material.sizeAttenuation = true
    material.toneMapped = false
  }

  const baseGeometry = (points as any).geometry as THREE.BufferGeometry | undefined

  return mode === 'raw' ? (
    <primitive object={points} />
  ) : baseGeometry ? (
    <LODPointCloud baseGeometry={baseGeometry} />
  ) : null
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'mesh' | 'pointcloud'>('mesh')
  const [pointCloudMode, setPointCloudMode] = useState<'raw' | 'lod'>('raw')
  const [controlsMinimized, setControlsMinimized] = useState(false)
  const controlsRef = useRef<any>(null)
  const rates = useMemo(
    () => ({
      truckPerSecond: 15.0,
      rotatePerSecond: Math.PI / 1.6,
      dollyPerSecond: 15.0,
      rollPerSecond: Math.PI / 2.2,
    }),
    [],
  )

  useEffect(() => {
    const id = requestAnimationFrame(() => controlsRef.current?.reset(true))
    return () => cancelAnimationFrame(id)
  }, [activeTab])

  const zoomInHold = useHoldAction((dt) => controlsRef.current?.dolly(rates.dollyPerSecond * dt, false))
  const zoomOutHold = useHoldAction((dt) => controlsRef.current?.dolly(-rates.dollyPerSecond * dt, false))

  const panStick = useJoystickAction((dt, x, y) => {
    // x: right+, y: down+ (screen space)
    controlsRef.current?.truck(x * rates.truckPerSecond * dt, y * rates.truckPerSecond * dt, false)
  })

  const rotateStick = useJoystickAction((dt, x, y) => {
    controlsRef.current?.rotate(-x * rates.rotatePerSecond * dt, -y * rates.rotatePerSecond * dt, false)
  })

  const rollBy = useCallback((angle: number) => {
    const controls = controlsRef.current
    const camera: THREE.PerspectiveCamera | THREE.OrthographicCamera | undefined = controls?.camera
    if (!controls || !camera) return

    const pos = new THREE.Vector3()
    const target = new THREE.Vector3()
    controls.getPosition?.(pos)
    controls.getTarget?.(target)

    const axis = target.sub(pos).normalize() // camera forward direction
    if (!Number.isFinite(axis.x + axis.y + axis.z)) return

    camera.up.applyAxisAngle(axis, angle).normalize()
    controls.setLookAt?.(pos.x, pos.y, pos.z, target.x, target.y, target.z, false)
  }, [])

  const rollLeftHold = useHoldAction((dt) => rollBy(rates.rollPerSecond * dt))
  const rollRightHold = useHoldAction((dt) => rollBy(-rates.rollPerSecond * dt))

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          zIndex: 10,
          display: 'flex',
          gap: 8,
          padding: 6,
          borderRadius: 12,
          background: 'rgba(0,0,0,0.35)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,255,255,0.12)',
        }}
      >
        <button
          type="button"
          onClick={() => setActiveTab('mesh')}
          aria-pressed={activeTab === 'mesh'}
          style={{
            cursor: 'pointer',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.18)',
            padding: '8px 10px',
            fontSize: 13,
            lineHeight: 1,
            color: activeTab === 'mesh' ? '#111' : 'rgba(255,255,255,0.9)',
            background: activeTab === 'mesh' ? '#fff' : 'rgba(0,0,0,0.2)',
          }}
        >
          Mesh
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('pointcloud')}
          aria-pressed={activeTab === 'pointcloud'}
          style={{
            cursor: 'pointer',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.18)',
            padding: '8px 10px',
            fontSize: 13,
            lineHeight: 1,
            color:
              activeTab === 'pointcloud' ? '#111' : 'rgba(255,255,255,0.9)',
            background:
              activeTab === 'pointcloud' ? '#fff' : 'rgba(0,0,0,0.2)',
          }}
        >
          Point cloud
        </button>
      </div>
      {activeTab === 'pointcloud' && (
        <div
          style={{
            position: 'absolute',
            top: 58,
            left: 12,
            zIndex: 10,
            display: 'grid',
            gap: 8,
            padding: 10,
            borderRadius: 14,
            background: 'rgba(0,0,0,0.35)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'rgba(255,255,255,0.9)',
            userSelect: 'none',
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.85 }}>Point cloud</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => setPointCloudMode('raw')}
              aria-pressed={pointCloudMode === 'raw'}
              style={{
                cursor: 'pointer',
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.18)',
                padding: '8px 10px',
                fontSize: 13,
                lineHeight: 1,
                color: pointCloudMode === 'raw' ? '#111' : 'rgba(255,255,255,0.9)',
                background: pointCloudMode === 'raw' ? '#fff' : 'rgba(0,0,0,0.2)',
              }}
            >
              Raw
            </button>
            <button
              type="button"
              onClick={() => setPointCloudMode('lod')}
              aria-pressed={pointCloudMode === 'lod'}
              style={{
                cursor: 'pointer',
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.18)',
                padding: '8px 10px',
                fontSize: 13,
                lineHeight: 1,
                color: pointCloudMode === 'lod' ? '#111' : 'rgba(255,255,255,0.9)',
                background: pointCloudMode === 'lod' ? '#fff' : 'rgba(0,0,0,0.2)',
              }}
            >
              LOD Points
            </button>
          </div>
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          right: 12,
          bottom: 12,
          zIndex: 10,
          display: 'grid',
          gap: 10,
          padding: 10,
          borderRadius: 14,
          background: 'rgba(0,0,0,0.35)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,255,255,0.12)',
          color: 'rgba(255,255,255,0.9)',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => setControlsMinimized(m => !m)}
            style={controlsMinimized
              ? { ...controlButtonStyle, width: 28, height: 28, padding: 0, fontSize: 15, lineHeight: 1 }
              : { ...controlButtonStyle, padding: '4px 8px', fontSize: 12, lineHeight: 1, display: 'flex', alignItems: 'center', gap: 4 }}
            aria-label={controlsMinimized ? 'Maximize controls' : 'Minimize controls'}
            title={controlsMinimized ? 'Maximize controls' : 'Minimize controls'}
          >
            {controlsMinimized ? '▴' : <><span>Minimize</span><span style={{ fontSize: 10 }}>▾</span></>}
          </button>
        </div>

        {!controlsMinimized && (
          <>
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, opacity: 0.85 }}>Pan</div>
              <Joystick label="Pan stick" knob={panStick.knob} handlers={panStick.handlers} />
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, opacity: 0.85 }}>Rotate</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8 }}>
                <Joystick label="Rotate stick" knob={rotateStick.knob} handlers={rotateStick.handlers} />
                <div style={{ display: 'grid', gap: 6 }}>
                  <button
                    type="button"
                    {...rollLeftHold}
                    style={{ ...controlButtonStyle, width: 44, height: 44, padding: 0 }}
                    aria-label="Roll left"
                    title="Roll left"
                  >
                    ↺
                  </button>
                  <button
                    type="button"
                    {...rollRightHold}
                    style={{ ...controlButtonStyle, width: 44, height: 44, padding: 0 }}
                    aria-label="Roll right"
                    title="Roll right"
                  >
                    ↻
                  </button>
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, opacity: 0.85 }}>Zoom</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <button
                  type="button"
                  {...zoomInHold}
                  style={controlButtonStyle}
                >
                  +
                </button>
                <button
                  type="button"
                  {...zoomOutHold}
                  style={controlButtonStyle}
                >
                  −
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => controlsRef.current?.reset(true)}
              style={{ ...controlButtonStyle, padding: '10px 12px', height: 44 }}
              aria-label="Reset view"
              title="Reset view"
            >
              Reset view
            </button>
          </>
        )}
      </div>
      <Canvas
        camera={{ position: [0, 0, 8], fov: 60 }}
        gl={{
          antialias: true,
          toneMapping: THREE.ACESFilmicToneMapping,
        }}
        onCreated={({ gl }) => {
          gl.toneMappingExposure = 1.35
        }}
      >
        <color attach="background" args={['#111']} />
        <ambientLight intensity={4} />
        <directionalLight position={[5, 5, 5]} intensity={5} />
        <directionalLight position={[-5, 5, -5]} intensity={5} />
        <directionalLight position={[0, 5, 0]} intensity={5} />
        <axesHelper args={[2]} />

        <Suspense fallback={null}>
          <Environment preset="city" />
          {activeTab === 'mesh' ? <MeshModel /> : <PointCloud mode={pointCloudMode} />}
        </Suspense>

        <CameraControls ref={controlsRef} makeDefault />
      </Canvas>
    </div>
  )
}

const controlButtonStyle: React.CSSProperties = {
  cursor: 'pointer',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.18)',
  padding: '8px 10px',
  fontSize: 13,
  lineHeight: 1,
  color: 'rgba(255,255,255,0.92)',
  background: 'rgba(0,0,0,0.2)',
}

function Joystick({
  label,
  knob,
  handlers,
}: {
  label: string
  knob: { x: number; y: number; active: boolean }
  handlers: JoystickHandlers
}) {
  const radius = 28
  const size = radius * 2 + 16
  const knobPxX = knob.x * radius
  const knobPxY = knob.y * radius

  return (
    <div
      role="application"
      aria-label={label}
      {...handlers}
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.18)',
        background: knob.active ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.18)',
        position: 'relative',
        touchAction: 'none',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <div
        style={{
          width: radius * 2,
          height: radius * 2,
          borderRadius: 999,
          background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.22), rgba(255,255,255,0) 55%)',
          border: '1px dashed rgba(255,255,255,0.18)',
          opacity: 0.9,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 30,
          height: 30,
          borderRadius: 999,
          border: '1px solid rgba(255,255,255,0.22)',
          background: 'rgba(255,255,255,0.14)',
          transform: `translate(${knobPxX}px, ${knobPxY}px)`,
          boxShadow: 'rgba(0,0,0,0.35) 0 10px 16px -8px',
        }}
      />
    </div>
  )
}