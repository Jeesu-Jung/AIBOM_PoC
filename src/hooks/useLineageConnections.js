import { useEffect } from "react";

function drawConnections(context) {
  if (!context) return;
  const board = document.querySelector(
    `[data-family-cluster="${CSS.escape(context.familyId)}"] .family-cluster-board`
  );
  const svg = board?.querySelector(".cluster-svg");
  if (!board || !svg) return;
  svg.innerHTML = "";
  if (window.innerWidth <= 640) return;

  const boardRect = board.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${boardRect.width} ${boardRect.height}`);
  const connections = [
    ...context.rootNodes.map((node) => ({
      from: context.documentNode.id,
      to: node.id,
      type: "document"
    })),
    ...context.derivedNodes.map((node) => ({
      from: node.parent,
      to: node.id,
      type: "root"
    }))
  ];

  connections.forEach((connection) => {
    const from = board.querySelector(`[data-node-id="${CSS.escape(connection.from)}"]`);
    const to = board.querySelector(`[data-node-id="${CSS.escape(connection.to)}"]`);
    if (!from || !to) return;
    const fromRect = from.getBoundingClientRect();
    const toRect = to.getBoundingClientRect();
    const startX = fromRect.left - boardRect.left + fromRect.width / 2;
    const startY = fromRect.top - boardRect.top + fromRect.height;
    const endX = toRect.left - boardRect.left + toRect.width / 2;
    const endY = toRect.top - boardRect.top;
    const controlY = startY + (endY - startY) * 0.5;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${startX} ${startY} C ${startX} ${controlY}, ${endX} ${controlY}, ${endX} ${endY}`);
    path.setAttribute("class", `edge-path edge-${connection.type}`);
    svg.appendChild(path);
  });
}

export function useLineageConnections(context, activeNodeId) {
  useEffect(() => {
    if (!context) return undefined;
    const redraw = () => drawConnections(context);
    const frame = requestAnimationFrame(redraw);
    window.addEventListener("resize", redraw);
    const board = document.querySelector(".family-cluster-board");
    const observer = "ResizeObserver" in window ? new ResizeObserver(redraw) : null;
    if (board) observer?.observe(board);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", redraw);
      observer?.disconnect();
    };
  }, [context, activeNodeId]);
}
