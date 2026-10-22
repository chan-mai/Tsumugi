import type { NodeJobOptions, NodeTrigger } from './flow.js';
import type { JobState } from './types.js';

// runの進行判断, 依存解決と中断判断はここで完結(ADR-0018)
// 時刻, ID採番不要の純粋関数

/** ジョブの7状態(ADR-0012)に未起動のPENDINGと不実行で終端のSKIPPEDを追加 */
export type NodeState = 'PENDING' | JobState | 'SKIPPED';

export type RunState = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/**
 * ノードの生成経路(ADR-0032)
 * fanOutの子の失敗は要約で後段へ渡し親の成否に不算入(ADR-0035)
 * spawnの子の失敗は親の失敗に算入
 */
export type NodeOrigin = 'static' | 'fanOut' | 'spawn';

export type NodeView = {
	id: string;
	state: NodeState;
	/** fan-outノード, ジョブを持たず子の展開と集約のみ */
	container: boolean;
	/** subflowノード, ジョブを持たず子のrunの終端を待機 */
	subflow: boolean;
	/** 実行時追加ノードの親, 静的ノードはnull */
	parent: string | null;
	origin: NodeOrigin;
	/** 静的な依存のノードID, 実行時追加ノードは空 */
	after: readonly string[];
	/** 実行時追加ノードは既定値(ADR-0041) */
	trigger: NodeTrigger;
};

export type RunDecision =
	/** ジョブを作成して投入 */
	| { type: 'start'; id: string }
	/** 子のrunを開始, 終端はその子からの通知で確定 */
	| { type: 'startRun'; id: string }
	/** fan-outノードの展開, overを評価して子を作成 */
	| { type: 'expand'; id: string }
	/** fan-outノードの集約, 子孫全ての終端到達後に自身を終端へ */
	| { type: 'aggregate'; id: string }
	/** 発火条件を満たさないノードの不実行, 理由はノードのerrorへ記録(ADR-0041) */
	| { type: 'skip'; id: string; reason: string }
	/** 取り消し, 未起動は即時終端, SCHEDULEDはJob DOへ取り消し送信 */
	| { type: 'cancel'; id: string };

export type AdvanceInput = {
	nodes: readonly NodeView[];
	/** 取り消し要求中, 未起動を停止し実行中の終端を待機 */
	cancelling: boolean;
	/** 期限超過, 取り消しと同じ処理で結果はFAILED(ADR-0039) */
	expired?: boolean;
};

export type AdvanceOutput = { decisions: RunDecision[]; state: RunState };

/** performの中で要求された子ノード(ADR-0032) */
export type SpawnRequest = {
	/** 親の下での名前, 利用者が指定 */
	id: string;
	binding: string;
	payload: unknown;
	options?: NodeJobOptions & { concurrencyKey?: string };
};

/**
 * Job DOからRun DOへのノード終端通知(ADR-0031)
 * spawnは同じ通知に同梱, 分割すると親の終端が先に届き下流が子を待たず実行
 */
export type NodeEvent = {
	nodeId: string;
	jobId: string;
	state: Extract<JobState, 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'STALLED'>;
	result: string | null;
	error: string | null;
	spawns?: readonly SpawnRequest[];
};

const TERMINAL: readonly NodeState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'STALLED', 'SKIPPED'];

// 不実行理由, 画面確認用にノードのerrorへ記録(ADR-0041)
const reasonOf = (trigger: NodeTrigger): string => (trigger === 'failure' ? 'no dependency failed' : 'a dependency did not succeed');

export function isNodeTerminal(state: NodeState): boolean {
	return TERMINAL.includes(state);
}

/**
 * 待ち合わせ単位は自身と子孫全ての終端(ADR-0032)
 * 親を`after`に指定したノードは実行時追加の子孫の終端も待機
 */
export function advance({ nodes, cancelling, expired = false }: AdvanceInput): AdvanceOutput {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const children = new Map<string, NodeView[]>();
	for (const node of nodes) {
		if (node.parent === null) continue;
		const siblings = children.get(node.parent);
		if (siblings) siblings.push(node);
		else children.set(node.parent, [node]);
	}

	const settledMemo = new Map<string, boolean>();
	const succeededMemo = new Map<string, boolean>();

	const settled = (node: NodeView): boolean => {
		const memo = settledMemo.get(node.id);
		if (memo !== undefined) return memo;
		// 子は親より後に作成, 親子関係に循環なしで再入なし
		const value = isNodeTerminal(node.state) && (children.get(node.id) ?? []).every(settled);
		settledMemo.set(node.id, value);
		return value;
	};

	const succeeded = (node: NodeView): boolean => {
		const memo = succeededMemo.get(node.id);
		if (memo !== undefined) return memo;
		const value =
			settled(node) &&
			node.state === 'COMPLETED' &&
			// fanOutの子の失敗は要約で後段へ, 親の成否に不算入(ADR-0035)
			(children.get(node.id) ?? []).every((child) => child.origin === 'fanOut' || succeeded(child));
		succeededMemo.set(node.id, value);
		return value;
	};

	/**
	 * SKIPPEDは経路の不選択で不算入, 上流の失敗は上流ノードで計上
	 * fanOutの子の失敗は親の失敗に不算入(ADR-0035)
	 */
	const failed = (node: NodeView): boolean =>
		node.state === 'FAILED' ||
		node.state === 'STALLED' ||
		node.state === 'CANCELLED' ||
		(children.get(node.id) ?? []).some((child) => child.origin !== 'fanOut' && failed(child));

	const halting = cancelling || expired;

	const decisions: RunDecision[] = [];
	for (const node of nodes) {
		// 取り消し中も集約継続, 停止時は子孫終了後もRUNNINGのまま残りrunが未完了
		if (node.container && node.state === 'RUNNING' && (children.get(node.id) ?? []).every(settled)) {
			decisions.push({ type: 'aggregate', id: node.id });
			continue;
		}

		if (halting) {
			// ジョブのノードは終端までSCHEDULED, 投入済みジョブにも取り消し要求(ADR-0052)
			if (node.state === 'PENDING' || node.state === 'SCHEDULED') decisions.push({ type: 'cancel', id: node.id });
			// 子runは実行中も取り消し, 親終了後の継続実行防止
			else if (node.subflow && node.state === 'RUNNING') decisions.push({ type: 'cancel', id: node.id });
			continue;
		}

		if (node.state === 'PENDING') {
			const deps = node.after.map((id) => byId.get(id));
			// flowから消えた依存は成否不明, 発火条件に関わらずSKIPPED(ADR-0030)
			const missing = deps.some((dep) => dep === undefined);
			if (missing) {
				decisions.push({ type: 'skip', id: node.id, reason: 'a dependency is missing from the flow' });
				continue;
			}
			const settledDeps = deps.filter((dep) => dep !== undefined);
			if (!settledDeps.every(settled)) continue;

			// failureは1つ以上の失敗が条件, SKIPPEDは経路の不選択で後処理不要(ADR-0041)
			const ready = node.trigger === 'always' ? true : node.trigger === 'failure' ? settledDeps.some(failed) : settledDeps.every(succeeded);
			if (!ready) decisions.push({ type: 'skip', id: node.id, reason: reasonOf(node.trigger) });
			else if (node.container) decisions.push({ type: 'expand', id: node.id });
			else decisions.push({ type: node.subflow ? 'startRun' : 'start', id: node.id });
		}
	}

	const roots = nodes.filter((node) => node.parent === null);
	// 全ノードはいずれかの根の子孫, 根の終端で全体も終端
	const done = roots.every(settled);
	// fan-outの子の失敗は非致命(ADR-0035), ノード状態から期限による中断は区別不能(ADR-0039)
	const state: RunState = !done ? 'RUNNING' : cancelling ? 'CANCELLED' : expired ? 'FAILED' : roots.some(failed) ? 'FAILED' : 'COMPLETED';

	return { decisions, state };
}
