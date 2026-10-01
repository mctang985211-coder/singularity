import { Context, Service } from "@deepseek-ai/cordis";
import { EventStoreSet } from "@dangosys/dsh-singularity-task";

//#region src/service/layout-state.ts
function copy(value) {
	return structuredClone(value);
}
var LayoutState = class LayoutState {
	value;
	constructor(id, snapshot) {
		this.value = snapshot === void 0 ? {
			version: 1,
			id,
			nodes: {}
		} : copy(snapshot);
	}
	clone() {
		return new LayoutState(this.value.id, this.value);
	}
	snapshot() {
		return copy(this.value);
	}
	get(sessionId) {
		const node = this.value.nodes[sessionId];
		if (node === void 0) throw new Error(`layout: unknown session "${sessionId}"`);
		return copy(node);
	}
	apply(event) {
		switch (event.kind) {
			case "node/set":
				this.value = {
					...this.value,
					nodes: {
						...this.value.nodes,
						[event.sessionId]: copy(event.node)
					}
				};
				return;
			case "node/remove": {
				if (this.value.nodes[event.sessionId] === void 0) throw new Error(`layout: unknown session "${event.sessionId}"`);
				const nodes = { ...this.value.nodes };
				delete nodes[event.sessionId];
				this.value = {
					...this.value,
					nodes
				};
				return;
			}
			default: throw new Error(`layout: unknown event kind "${event.kind}"`);
		}
	}
};

//#endregion
//#region src/service/layout.ts
var LayoutService = class extends Service {
	static inject = ["sessionPersistence"];
	stores;
	activeId;
	constructor(ctx, config = {}) {
		super(ctx, "layout");
		this.stores = new EventStoreSet(ctx, {
			namespace: "layout",
			eventType: "layout/event",
			changeEvent: "layout/change",
			createState: (id) => new LayoutState(id),
			defaultStoreId: config.storeId ?? "layout-idle",
			onDemand: true
		});
		this.stores.load();
		ctx.effect(() => () => this.stores.close(), "layout:persistence");
	}
	async switchStore(id) {
		const snapshot = await this.stores.snapshot(id);
		this.activeId = id;
		this.ctx.emit("layout/change", snapshot);
		return snapshot;
	}
	clearActive() {
		if (this.stores.closed) throw new Error("layout: service is closing");
		this.activeId = void 0;
	}
	async snapshot() {
		return await this.stores.snapshot(this.activeIdOf());
	}
	async snapshotIn(id) {
		return await this.stores.snapshot(id);
	}
	async set(sessionId, node) {
		await this.setIn(this.activeIdOf(), sessionId, node);
	}
	async setIn(id, sessionId, node) {
		await this.commitIn(id, [{
			kind: "node/set",
			sessionId,
			node
		}]);
	}
	async commitIn(id, events) {
		await this.stores.commit(id, events);
	}
	activeIdOf() {
		if (this.activeId === void 0) throw new Error("layout: no graph selected");
		return this.activeId;
	}
};

//#endregion
//#region src/layout-types.ts
const DEFAULT_ROOT = {
	x: 80,
	y: 80,
	width: 168,
	height: 76,
	shape: "card"
};

//#endregion
//#region src/layout.ts
var layout_default = LayoutService;

//#endregion
export { LayoutState as i, DEFAULT_ROOT as n, LayoutService as r, layout_default as t };