import type { NodeJobOptions, NodeTrigger } from './flow.js';
import type { JobState } from './types.js';

/**
 * runの進行判断(ADR-0018)
 *
 * Run DOはこの関数の決定に従うだけで、依存の解決も中断もここで完結
 * 時刻もIDの採番も不要で純粋に維持可能
 */

/**
 * ノードの状態
 * ジョブの7状態(ADR-0012)に、未起動のPENDINGと上流の失敗で実行されずに終わるSKIPPEDを追加
 */
export type NodeState = 'PENDING' | JobState | 'SKIPPED';

/** runの状態,ノードを集約した結果 */
export type RunState = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/**
 * ノードの生成経路(ADR-0032)
 * fanOutの子の失敗数は要約で後段へ渡り親は許容, spawnの子は受け取る口が無く非許容(ADR-0035)
 */
export type NodeOrigin = 'static' | 'fanOut' | 'spawn';

export type NodeView = {
	id: string;
	state: NodeState;
	/** fan-outノード, ジョブを持たず子の展開と集約のみ */
	container: boolean;
	/** subflowノード, ジョブを持たず子のrunの終端を待機 */
	subflow: boolean;
	/** 実行時に増えたノードの親,静的ノードはnull */
	parent: string | null;
	origin: NodeOrigin;
	/** 静的な依存のノードID, 実行時に増えたノードには無し */
	after: readonly string[];
	/** 依存の成否に対する発火条件, 実行時に増えたノードは依存が無く既定のまま(ADR-0041) */
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
	/** 取り消し, 未起動はその場で終端に, SCHEDULEDはJob DOへ取り消しを送信 */
	| { type: 'cancel'; id: string };

export type AdvanceInput = {
	nodes: readonly NodeView[];
	/** 取り消しの要求中, 未起動を停止して実行中の終端を待機 */
	cancelling: boolean;
	/** 期限超過の印, 取り消しと同じ処理で決着をFAILEDへ(ADR-0039) */
	expired?: boolean;
};

export type AdvanceOutput = { decisions: RunDecision[]; state: RunState };

/** performの中で要求された子ノード(ADR-0032) */
export type SpawnRequest = {
	/** 親の下での名前, 利用者が明示 */
	id: string;
	binding: string;
	payload: unknown;
	options?: NodeJobOptions & { concurrencyKey?: string };
};

/**
 * Job DOがRun DOへ送る1件(ADR-0031)
 * spawnは同じ通知に同梱, 分けると親の決着が先に届き下流が子を待たず実行
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

/** 実行しなかった理由, 画面での確認用にノードのerrorへ記録(ADR-0041) */
const reasonOf = (trigger: NodeTrigger): string => (trigger === 'failure' ? 'no dependency failed' : 'a dependency did not succeed');

export function isNodeTerminal(state: NodeState): boolean {
	return TERMINAL.includes(state);
}

/**
 * 次の操作とrunの状態の決定
 *
 * 待ち合わせの単位は「自身が終端かつ子孫も全て終端」(ADR-0032)
 * 親を`after`で待つノードは、実行時に増えた子孫の完了も自動的に待機
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

	/** 後続が待つ単位,自身が終端で子孫も全て終端 */
	const settled = (node: NodeView): boolean => {
		const memo = settledMemo.get(node.id);
		if (memo !== undefined) return memo;
		// 再入は無い, 子は親より後にしか作られず親子関係に循環は無い
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
			// fanOutの子の失敗は要約に含まれ後段へ渡り、親の成否には不算入(ADR-0035)
			(children.get(node.id) ?? []).every((child) => child.origin === 'fanOut' || succeeded(child));
		succeededMemo.set(node.id, value);
		return value;
	};

	/**
	 * 自身か子孫に失敗があるか(ADR-0041)
	 * SKIPPEDは経路の不選択で失敗ではなく不算入, 上流の失敗はその上流のノードに出現
	 * fanOutの子の失敗は要約で後段へ渡り親の失敗には不算入(ADR-0035)
	 */
	const failed = (node: NodeView): boolean =>
		node.state === 'FAILED' ||
		node.state === 'STALLED' ||
		node.state === 'CANCELLED' ||
		(children.get(node.id) ?? []).some((child) => child.origin !== 'fanOut' && failed(child));

	// 期限超過も取り消しと同じ処理, 未起動を停止して実行中の終端を待機(ADR-0039)
	const halting = cancelling || expired;

	const decisions: RunDecision[] = [];
	for (const node of nodes) {
		// fan-outノードのジョブは非実行, 子孫全ての終端到達で自身を終端へ
		// 取り消し中も集約は継続, 停止すると子孫終了後もRUNNINGのまま残りrunが未決着
		if (node.container && node.state === 'RUNNING' && (children.get(node.id) ?? []).every(settled)) {
			decisions.push({ type: 'aggregate', id: node.id });
			continue;
		}

		if (halting) {
			// QUEUED以降は取り消し成功の保証が無く送っても拒否(ADR-0012), 送信は省略
			if (node.state === 'PENDING' || node.state === 'SCHEDULED') decisions.push({ type: 'cancel', id: node.id });
			// 子のrunは実行中でも取り消し可能, 親の終了後の継続実行を防止
			else if (node.subflow && node.state === 'RUNNING') decisions.push({ type: 'cancel', id: node.id });
			continue;
		}

		if (node.state === 'PENDING') {
			const deps = node.after.map((id) => byId.get(id));
			// 消えた依存は成否が不明, どの発火条件でも中断(ADR-0030)
			const missing = deps.some((dep) => dep === undefined);
			if (missing) {
				decisions.push({ type: 'skip', id: node.id, reason: 'a dependency is missing from the flow' });
				continue;
			}
			const settledDeps = deps.filter((dep) => dep !== undefined);
			if (!settledDeps.every(settled)) continue;

			// failureは1つ以上の失敗が条件, SKIPPEDは経路の不選択で後処理は不要(ADR-0041)
			const ready = node.trigger === 'always' ? true : node.trigger === 'failure' ? settledDeps.some(failed) : settledDeps.every(succeeded);
			if (!ready) decisions.push({ type: 'skip', id: node.id, reason: reasonOf(node.trigger) });
			else if (node.container) decisions.push({ type: 'expand', id: node.id });
			else decisions.push({ type: node.subflow ? 'startRun' : 'start', id: node.id });
		}
	}

	const roots = nodes.filter((node) => node.parent === null);
	// 全ノードは必ずいずれかの根に連なり、根の決着で全体の決着が確定
	const done = roots.every(settled);
	// 取り消しを優先, 期限超過は残りが全て成功していてもFAILED
	// fan-outの子の失敗は非致命(ADR-0035)で、ノードの状態から期限による中断は区別不能(ADR-0039)
	const state: RunState = !done ? 'RUNNING' : cancelling ? 'CANCELLED' : expired ? 'FAILED' : roots.some(failed) ? 'FAILED' : 'COMPLETED';

	return { decisions, state };
}
