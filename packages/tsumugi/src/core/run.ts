import type { NodeJobOptions } from './flow.js';
import type { JobState } from './types.js';

/**
 * runの進行判断(ADR-0018)
 *
 * Run DOはこの関数の決定に従うだけで,依存の解決も打ち切りもここに閉じる
 * 時刻もIDの採番も要らないので純粋に保てる
 */

/**
 * ノードの状態
 * ジョブの7状態(ADR-0012)に,未起動のPENDINGと上流の失敗で実行されずに終わるSKIPPEDを追加する
 */
export type NodeState = 'PENDING' | JobState | 'SKIPPED';

/** runの状態,ノードを集約した結果 */
export type RunState = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/**
 * ノードの生まれ方(ADR-0032)
 * fanOutの子は失敗数を要約で後段へ渡すので親が許容する, spawnの子は受け取る口が無いので許容しない(ADR-0035)
 */
export type NodeOrigin = 'static' | 'fanOut' | 'spawn';

export type NodeView = {
	id: string;
	state: NodeState;
	/** fan-outノード, ジョブを持たず子の展開と集約のみを行う */
	container: boolean;
	/** subflowノード, ジョブを持たず子のrunの終端を待つ */
	subflow: boolean;
	/** 実行時に増えたノードの親,静的ノードはnull */
	parent: string | null;
	origin: NodeOrigin;
	/** 静的な依存のノードID,実行時に増えたノードは持たない */
	after: readonly string[];
};

export type RunDecision =
	/** ジョブを作って投入する */
	| { type: 'start'; id: string }
	/** 子のrunを開始する, 終端はその子からの通知で決まる */
	| { type: 'startRun'; id: string }
	/** fan-outノードの展開, overを評価して子を作る */
	| { type: 'expand'; id: string }
	/** fan-outノードの集約, 子孫が全て終端に達したので自身を終端へ進める */
	| { type: 'aggregate'; id: string }
	/** 上流が失敗したので実行しない */
	| { type: 'skip'; id: string }
	/** 取り消し,未起動はその場で終端に, SCHEDULEDはJob DOへ取り消しを送る */
	| { type: 'cancel'; id: string };

export type AdvanceInput = {
	nodes: readonly NodeView[];
	/** 取り消しが要求されている,未起動を止めて実行中の終端を待つ */
	cancelling: boolean;
};

export type AdvanceOutput = { decisions: RunDecision[]; state: RunState };

/** performの中で要求された子ノード(ADR-0032) */
export type SpawnRequest = {
	/** 親の下での名前,利用者が明示する */
	id: string;
	binding: string;
	payload: unknown;
	options?: NodeJobOptions & { concurrencyKey?: string };
};

/**
 * Job DOがRun DOへ運ぶ1件(ADR-0031)
 * spawnは同じ便に含める, 別便にすると親の決着が先に届き下流が子を待たずに実行される
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

export function isNodeTerminal(state: NodeState): boolean {
	return TERMINAL.includes(state);
}

/**
 * 次に打つ手とrunの状態を決める
 *
 * 待ち合わせの単位は「自身が終端かつ子孫も全て終端」(ADR-0032)
 * 親を`after`で待つノードは,実行時に増えた子孫の完了も自動的に待つ
 */
export function advance({ nodes, cancelling }: AdvanceInput): AdvanceOutput {
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

	/** 後続が待つ単位,自身が終端で子孫も全て終端 */
	const settled = (node: NodeView): boolean => {
		const memo = settledMemo.get(node.id);
		if (memo !== undefined) return memo;
		// 再入は起きない, 子は親より後にしか生まれず親子関係は循環しない
		const value = isNodeTerminal(node.state) && (children.get(node.id) ?? []).every(settled);
		settledMemo.set(node.id, value);
		return value;
	};

	/** 下流を実行してよいか, 自身の成功と子孫の成功の両方が必要 */
	const succeeded = (node: NodeView): boolean => {
		const memo = succeededMemo.get(node.id);
		if (memo !== undefined) return memo;
		const value =
			settled(node) &&
			node.state === 'COMPLETED' &&
			// fanOutの子は失敗しても要約に載って後段へ渡るので,親の成否には数えない(ADR-0035)
			(children.get(node.id) ?? []).every((child) => child.origin === 'fanOut' || succeeded(child));
		succeededMemo.set(node.id, value);
		return value;
	};

	const decisions: RunDecision[] = [];
	for (const node of nodes) {
		// fan-outノードはジョブを実行しない, 子孫が全て終端に達した時点で自身を終端へ進める
		// 取り消し中も集約する, 止めると子孫が終わってもRUNNINGのまま残りrunが決着しない
		if (node.container && node.state === 'RUNNING' && (children.get(node.id) ?? []).every(settled)) {
			decisions.push({ type: 'aggregate', id: node.id });
			continue;
		}

		if (cancelling) {
			// QUEUED以降は取り消せていない場合に成功を返さない(ADR-0012), 送っても断られるので出さない
			if (node.state === 'PENDING' || node.state === 'SCHEDULED') decisions.push({ type: 'cancel', id: node.id });
			// 子のrunは実行中でも取り消せる, 親が終わった後も動き続けるのを防ぐ
			else if (node.subflow && node.state === 'RUNNING') decisions.push({ type: 'cancel', id: node.id });
			continue;
		}

		if (node.state === 'PENDING') {
			const deps = node.after.map((id) => byId.get(id));
			// 消えた依存は待っても解決しないので, 決着を待たずに打ち切る(ADR-0030)
			const missing = deps.some((dep) => dep === undefined);
			if (!missing && !deps.every((dep) => dep !== undefined && settled(dep))) continue;
			const ready = !missing && deps.every((dep) => dep !== undefined && succeeded(dep));
			if (!ready) decisions.push({ type: 'skip', id: node.id });
			else if (node.container) decisions.push({ type: 'expand', id: node.id });
			else decisions.push({ type: node.subflow ? 'startRun' : 'start', id: node.id });
		}
	}

	const roots = nodes.filter((node) => node.parent === null);
	// 全ノードは必ずいずれかの根に連なるので,根の決着で全体の決着が分かる
	const done = roots.every(settled);
	const state: RunState = !done ? 'RUNNING' : cancelling ? 'CANCELLED' : roots.every(succeeded) ? 'COMPLETED' : 'FAILED';

	return { decisions, state };
}
