# r3fviewer

An interactive 3D viewer for mesh models and point clouds, built with React Three Fiber. Supports GLB mesh viewing and large PCD point clouds with shader-based rendering and spatial Level-of-Detail (LOD) optimization.

## Features

- **Dual viewing modes** — switch between mesh (GLB) and point cloud (PCD) views
- **Streaming point cloud** — cloud appears immediately at 10% density as large spheres; higher-density LODs stream in progressively in the background via a two-phase Web Worker pipeline
- **Custom shader rendering** — sphere-based point rendering with per-pixel lighting via GLSL vertex/fragment shaders
- **Joystick camera controls** — pan, rotate, roll, zoom, and reset via on-screen controls with pointer event support (mouse and touch)
- **ACES Filmic tone mapping** with environment lighting for realistic mesh rendering

## Tech Stack

- [React](https://react.dev/) 19 + TypeScript
- [Three.js](https://threejs.org/) + [React Three Fiber](https://docs.pmnd.rs/react-three-fiber) + [Drei](https://github.com/pmndrs/drei)
- [Vite](https://vitejs.dev/) (with Oxc compiler via `@vitejs/plugin-react`)
- Web Workers for off-thread LOD computation

## Getting Started

**Prerequisites:** Node.js 16+

```bash
npm install
npm run dev
```

The dev server runs at `http://localhost:5173` with hot module replacement.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server |
| `npm run build` | Type-check and build for production (output: `dist/`) |
| `npm run preview` | Preview production build locally |
| `npm run lint` | Run ESLint |

## Assets

Place your data files in `public/`:

| File | Description |
|---|---|
| `public/mesh.glb` | 3D mesh model |
| `public/pointcloud.pcd` | Point cloud data (with RGB color) |

These files are git-ignored due to size.

## Streaming LOD System

Point cloud data is processed entirely off-thread in a Web Worker. Loading happens in two phases to get pixels on screen as fast as possible:

**Phase 1 — immediate (ultralow)**
The cloud is partitioned into a 6×6×6 grid (216 cells) and each cell is voxel-downsampled to 10% density. These ultralow geometries are transferred to the main thread right away, so the viewer renders the full cloud outline as large spheres before any further work is done.

**Phase 2 — progressive upgrade (low → full)**
With phase 1 already rendered, the worker builds four denser LOD levels for every cell and sends them in a second message. Once they arrive, each cell silently upgrades its available geometries without any visible pop.

| Level | Density | Camera distance |
|---|---|---|
| `full` | 100% | < 10 units |
| `high` | 75% | 10 – 24 units |
| `mid` | 50% | 24 – 50 units |
| `low` | 25% | 50 – 80 units |
| `ultralow` | 10% | > 80 units |

Each frame, every cell checks the camera distance to its center and activates the appropriate LOD level. If phase 2 hasn't arrived yet, cells fall back to ultralow. Point size in the shader scales with distance — spheres appear larger when far away and shrink as the camera approaches a surface, giving a natural density gradient.
