# r3fviewer

An interactive 3D viewer for mesh models and point clouds, built with React Three Fiber. Supports GLB mesh viewing and large PCD point clouds with shader-based rendering and spatial Level-of-Detail (LOD) optimization.

## Features

- **Dual viewing modes** — switch between mesh (GLB) and point cloud (PCD) views
- **Spatial LOD for point clouds** — points partitioned into a 6×6×6 grid with 5 LOD levels (full → ultralow) based on camera distance, processed off-thread via Web Workers
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

## LOD System

Point cloud data is partitioned spatially into a 6×6×6 grid (216 cells). Each cell is independently downsampled to 5 LOD levels using voxel-based sampling in a Web Worker:

| Level | Density | Distance |
|---|---|---|
| `full` | 100% | Nearest |
| `high` | 75% | — |
| `mid` | 50% | — |
| `low` | 25% | — |
| `ultralow` | 10% | Farthest |

The active LOD level per cell is determined each frame based on the camera's distance to that cell's center.
