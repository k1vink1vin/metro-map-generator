import type {
  GraphModel,
  MoscowRingDefinition,
  ValidatedMoscowRing,
} from '../types';

export function validateMoscowRings(
  graph: GraphModel,
  definitions: MoscowRingDefinition[] = [],
): ValidatedMoscowRing[] {
  if (definitions.length > 3) {
    throw new Error('莫斯科環最多只能定義 3 個。');
  }

  const seenIds = new Set<string>();
  const usedNodes = new Set<string>();
  const validated: ValidatedMoscowRing[] = [];

  for (const definition of definitions) {
    const id = definition.id.trim();
    if (!id) throw new Error('莫斯科環編號不可空白。');
    if (seenIds.has(id)) {
      throw new Error(`莫斯科環編號重複：${id}`);
    }
    seenIds.add(id);

    const mapped = definition.stationIds.map((stationId) => {
      const nodeId = graph.stationToNode.get(stationId);
      if (!nodeId) {
        throw new Error(
          `莫斯科環 ${id} 使用不存在的車站編號：${stationId}`,
        );
      }
      return nodeId;
    });

    let nodes = mapped;
    if (nodes.length >= 2 && nodes[0] === nodes[nodes.length - 1]) {
      nodes = nodes.slice(0, -1);
    }

    const collapsed = nodes.filter(
      (nodeId, index) => index === 0 || nodeId !== nodes[index - 1],
    );

    if (collapsed.length < 3) {
      throw new Error(`莫斯科環 ${id} 至少需要 3 個不同 topology 節點。`);
    }

    const distinct = new Set(collapsed);
    if (distinct.size !== collapsed.length) {
      throw new Error(`莫斯科環 ${id} 內有重複節點，請只列一圈，不要繞第二次。`);
    }

    for (const nodeId of collapsed) {
      if (usedNodes.has(nodeId)) {
        throw new Error(
          `莫斯科多環目前不可共用同一個 topology 節點：${graph.nodeById.get(nodeId)?.name ?? nodeId}`,
        );
      }
    }

    for (let index = 0; index < collapsed.length; index += 1) {
      const a = collapsed[index];
      const b = collapsed[(index + 1) % collapsed.length];
      if (!(graph.adjacency.get(a) ?? []).includes(b)) {
        throw new Error(
          `莫斯科環 ${id} 未閉合：${graph.nodeById.get(a)?.name ?? a} → ${graph.nodeById.get(b)?.name ?? b} 之間沒有直接路段。`,
        );
      }
    }

    collapsed.forEach((nodeId) => usedNodes.add(nodeId));
    validated.push({
      id,
      stationIds: [...definition.stationIds],
      nodes: collapsed,
    });
  }

  return validated;
}
