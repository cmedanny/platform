// The Brain: every crawl, thesis and note as a node.

export type NodeKind = 'crawl' | 'thesis' | 'note';

export interface BrainNode {
  /** kind:id, e.g. crawl:crawl_abc */
  id: string;
  kind: NodeKind;
  refId: string;
  runId: string | null;
  title: string;
  subtitle: string;
  createdAt: number;
  tickers: string[];
  themes: string[];
  /** draft | edited | approved | sent | done | error | note */
  status: string;
  /** relative size, 1..5 */
  weight: number;
  links: string[];
}

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}
