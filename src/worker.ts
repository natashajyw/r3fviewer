/// <reference lib="webworker" />

function partition(positions: Float32Array, colors: Float32Array, nx: number, ny: number, nz: number) {
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i]!   < minX) minX = positions[i]!
      if (positions[i]!   > maxX) maxX = positions[i]!
      if (positions[i+1]! < minY) minY = positions[i+1]!
      if (positions[i+1]! > maxY) maxY = positions[i+1]!
      if (positions[i+2]! < minZ) minZ = positions[i+2]!
      if (positions[i+2]! > maxZ) maxZ = positions[i+2]!
    }

    const dx = (maxX - minX) / nx
    const dy = (maxY - minY) / ny
    const dz = (maxZ - minZ) / nz

    // one bucket per cell
    const posLists: number[][] = Array.from({ length: nx * ny * nz }, () => [])
    const colLists: number[][] = Array.from({ length: nx * ny * nz }, () => [])

    for (let i = 0; i < positions.length; i += 3) {
      const ix = Math.min(nx - 1, Math.floor((positions[i]!   - minX) / dx))
      const iy = Math.min(ny - 1, Math.floor((positions[i+1]! - minY) / dy))
      const iz = Math.min(nz - 1, Math.floor((positions[i+2]! - minZ) / dz))
      const idx = ix + iy * nx + iz * nx * ny
      posLists[idx]!.push(positions[i]!, positions[i+1]!, positions[i+2]!)
      colLists[idx]!.push(colors[i]!, colors[i+1]!, colors[i+2]!)
    }

    return posLists.map((posList, idx) => {
      const iz = Math.floor(idx / (nx * ny))
      const iy = Math.floor((idx % (nx * ny)) / nx)
      const ix = idx % nx
      return {
        center: [
          minX + (ix + 0.5) * dx,
          minY + (iy + 0.5) * dy,
          minZ + (iz + 0.5) * dz,
        ] as [number, number, number],
        positions: new Float32Array(posList),
        colors: new Float32Array(colLists[idx]!),
      }
    })
  }

function downsample(positions: Float32Array, colors: Float32Array, fraction: number) {
    const targetCount = Math.floor(positions.length / 3 * fraction)

    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i]!   < minX) minX = positions[i]!
      if (positions[i]!   > maxX) maxX = positions[i]!
      if (positions[i+1]! < minY) minY = positions[i+1]!
      if (positions[i+1]! > maxY) maxY = positions[i+1]!
      if (positions[i+2]! < minZ) minZ = positions[i+2]!
      if (positions[i+2]! > maxZ) maxZ = positions[i+2]!
    }

    const volume = (maxX-minX) * (maxY-minY) * (maxZ-minZ)
    const voxelSize = Math.cbrt(volume / targetCount)
    const inv = 1 / voxelSize

    const seen = new Map<number, true>()
    const outPos: number[] = []
    const outCol: number[] = []

    for (let i = 0; i < positions.length; i += 3) {
      const ix = Math.floor((positions[i]!   - minX) * inv)
      const iy = Math.floor((positions[i+1]! - minY) * inv)
      const iz = Math.floor((positions[i+2]! - minZ) * inv)
      const key = (ix << 22) | (iy << 11) | iz
      if (seen.has(key)) continue
      seen.set(key, true)
      outPos.push(positions[i]!, positions[i+1]!, positions[i+2]!)
      outCol.push(colors[i]!, colors[i+1]!, colors[i+2]!)
    }

    return {
      positions: new Float32Array(outPos),
      colors: new Float32Array(outCol),
    }
}

self.onmessage = (e) => {
    const { positions, colors } = e.data

    const cells = partition(positions, colors, 6, 6, 6)

    // Phase 1: send ultralow for all cells immediately so the viewer can show
    // something while the heavier LOD data is still being computed.
    const phase1Cells = cells.map(cell => ({
      center: cell.center,
      ultralow: downsample(cell.positions, cell.colors, 0.10),
    }))

    const phase1Transfers: ArrayBuffer[] = []
    for (const cell of phase1Cells) {
      phase1Transfers.push(cell.ultralow.positions.buffer, cell.ultralow.colors.buffer)
    }
    self.postMessage({ phase: 'ultralow', cells: phase1Cells }, phase1Transfers)

    // Phase 2: build higher LOD levels and send them.
    // The original cell positions/colors are still alive — only the downsampled
    // ultralow buffers were transferred above.
    const phase2Cells = cells.map(cell => ({
      low:  downsample(cell.positions, cell.colors, 0.25),
      mid:  downsample(cell.positions, cell.colors, 0.50),
      high: downsample(cell.positions, cell.colors, 0.75),
      full: { positions: cell.positions, colors: cell.colors },
    }))

    const phase2Transfers: ArrayBuffer[] = []
    for (const cell of phase2Cells) {
      phase2Transfers.push(
        cell.low.positions.buffer,  cell.low.colors.buffer,
        cell.mid.positions.buffer,  cell.mid.colors.buffer,
        cell.high.positions.buffer, cell.high.colors.buffer,
        cell.full.positions.buffer, cell.full.colors.buffer,
      )
    }
    self.postMessage({ phase: 'higher', cells: phase2Cells }, phase2Transfers)
  }
