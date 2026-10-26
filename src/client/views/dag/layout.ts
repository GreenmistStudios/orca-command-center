import type ELKType from 'elkjs/lib/elk.bundled.js'
import { isolatedGrid, type Graph, type LayoutFn, type Positions } from './model'

let elk: InstanceType<typeof ELKType> | null = null

/** ELK is ~1.4 MB; load it on first layout so the DAG view's own chunk stays small. */
async function getElk(): Promise<InstanceType<typeof ELKType>> {
  if (!elk) {
    const { default: ELK } = await import('elkjs/lib/elk.bundled.js')
    elk = new ELK()
  }
  return elk
}

/** Default ELK layout (design-system §10.2); isolated nodes are gridded below the DAG. */
export const elkLayout: LayoutFn = async (graph: Graph, direction) => {
  const main = graph.nodes.filter((n) => !n.isolated)
  const isolated = graph.nodes.filter((n) => n.isolated)
  const out: Positions = {}
  let bottom = 0
  if (main.length) {
    const engine = await getElk()
    const res = await engine.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered', 'elk.direction': direction, 'elk.separateConnectedComponents': 'true',
        'elk.layered.spacing.nodeNodeBetweenLayers': '70', 'elk.spacing.nodeNode': '30', 'elk.spacing.componentComponent': '60',
      },
      children: main.map((n) => ({ id: n.id, width: n.w, height: n.h })),
      edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    })
    for (const c of res.children ?? []) {
      out[c.id] = { x: c.x ?? 0, y: c.y ?? 0 }
      bottom = Math.max(bottom, (c.y ?? 0) + (c.height ?? 0))
    }
  }
  isolatedGrid(isolated.length, main.length ? bottom : -120).forEach((p, i) => { out[isolated[i].id] = p })
  return out
}
