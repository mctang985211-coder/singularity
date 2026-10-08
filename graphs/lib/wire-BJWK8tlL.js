//#region src/protocol.ts
/** Graph protocol marker and access mode: the single source that tells a current graph from a sealed legacy one. */
/** The literal identity of the current protocol; a graph's protocol is fixed at creation and never rewritten. */
const GRAPH_PROTOCOL_V2 = "singularity/graph@2";
/** The protocol marker a record carries; absent means the graph predates marking. */
function protocolOf(graph) {
	return graph.protocol;
}
/** A marked graph is current, an unmarked one is sealed legacy read-only history; there is no third state. */
function graphAccess(graph) {
	const protocol = protocolOf(graph);
	if (protocol === void 0) return {
		mode: "legacy-readonly",
		reason: `graph "${graph.id}" carries no protocol marker; it predates ${GRAPH_PROTOCOL_V2}`
	};
	return {
		mode: "current",
		protocol
	};
}
/** The error every write path on a sealed legacy graph answers with. */
var GraphSealedError = class extends Error {
	code = "graph-sealed";
	graphId;
	constructor(graphId) {
		super(`graphs: graph "${graphId}" is sealed legacy history (no ${GRAPH_PROTOCOL_V2} marker); it is read-only`);
		this.name = "GraphSealedError";
		this.graphId = graphId;
	}
};
/** The marker a current graph carries; throws {@link GraphSealedError} on a sealed legacy graph. */
function assertCurrentGraph(graph) {
	const protocol = protocolOf(graph);
	if (protocol === void 0) throw new GraphSealedError(graph.id);
	return protocol;
}

//#endregion
//#region src/wire.ts
/** One graph record's access mode, as every wire and route reports it. */
function graphAccessWire(graph) {
	const access = graphAccess(graph);
	return access.mode === "current" ? { mode: "current" } : {
		mode: "legacy-readonly",
		reason: access.reason
	};
}

//#endregion
export { graphAccess as a, assertCurrentGraph as i, GRAPH_PROTOCOL_V2 as n, protocolOf as o, GraphSealedError as r, graphAccessWire as t };