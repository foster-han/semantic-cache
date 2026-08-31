/**
 * 探针共用的打分与统计。
 *
 * 抽出来的理由不是省行数，是**先前每个探针各抄了一份，而它们抄得不一样**：
 * `Models.ts` 里的 cross-encoder 打分按 logits 路数分派（3 路直接抛，因为不知道
 * 哪一路是「相关」），探针里那份却默认取最后一路 —— 取错路分数整个反向，而且
 * 一路不报错。同一件事有两种实现时，被信任的总是错的那一份。
 */

export function softmax(xs: ReadonlyArray<number>): Array<number> {
	const m = Math.max(...xs);
	const e = xs.map(x => Math.exp(x - m));
	const s = e.reduce((a, b) => a + b, 0);
	return e.map(x => x / s);
}

export function median(xs: ReadonlyArray<number>): number {
	const a = [...xs].sort((x, y) => x - y);
	const m = a.length >> 1;
	return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function quantile(xs: ReadonlyArray<number>, p: number): number {
	const a = [...xs].sort((x, y) => x - y);
	return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))];
}

/**
 * 把一次 sequence-classification 的 logits 变成「越大越相关」的 0~1 分数。
 *
 * **必须看有几路。** 单 logit 走 sigmoid；两分类走 softmax 取正类（`data[0]` 是
 * **不**相关那一路，取错方向就反了）；三路以上是 NLI 那类，必须由调用方指出
 * 哪一路是「蕴含」，猜错不会报错只会给出没有意义的分数。
 */
export function scoreFromLogits(
	values: ReadonlyArray<number>,
	dims: ReadonlyArray<number> | undefined,
	entailIndex?: number,
): number {
	const routes = dims && dims.length > 0 ? dims[dims.length - 1] : values.length;
	if (routes === 1) return 1 / (1 + Math.exp(-values[0]));
	if (routes === 2) return softmax([values[0], values[1]])[1];
	if (entailIndex !== undefined && entailIndex >= 0) return softmax(values)[entailIndex];
	throw new Error(
		`打分器输出 ${routes} 路 logits，不知道哪一路表示「相关/蕴含」。` +
			"三路以上必须显式给出 entailIndex（从 model.config.id2label 里找 entailment）—— " +
			"猜错的后果是分数没有意义，而且程序照常跑完。",
	);
}

/** 一个工作点：阈值、命中率、正命中率、正确拒绝 */
export interface OperatingPoint {
	readonly theta: number;
	/** 该命中的里面命中了几成（recall） */
	readonly hit: number;
	/** 命中的里面对了几成（precision） */
	readonly precision: number;
	/** 该拦下的里面拦对了几成 */
	readonly reject: number;
}

/**
 * 扫遍所有阈值，把整条曲线摆出来。
 *
 * **不返回「最优点」。** 假正（返回错答案）和假负（白花一次生成）的代价完全不同，
 * 该选哪个点是产品决定，不是脚本决定。
 */
export function sweep(scores: ReadonlyArray<number>, labels: ReadonlyArray<number>): Array<OperatingPoint> {
	const total1 = labels.filter(l => l === 1).length;
	const total0 = labels.length - total1;
	const out: Array<OperatingPoint> = [];
	for (const theta of [...new Set(scores)].sort((a, b) => a - b)) {
		let tp = 0;
		let fp = 0;
		for (let i = 0; i < scores.length; i++) {
			if (scores[i] >= theta) {
				if (labels[i] === 1) tp += 1;
				else fp += 1;
			}
		}
		out.push({
			theta,
			hit: total1 === 0 ? 0 : tp / total1,
			precision: tp + fp === 0 ? 1 : tp / (tp + fp),
			reject: total0 === 0 ? 1 : (total0 - fp) / total0,
		});
	}
	return out;
}

/**
 * 「正命中率不低于 floor 时，命中率最高能到多少」。
 *
 * **门槛低于全放行基线时返回 null。** 子集的正例率就是全放行的正命中率 ——
 * 一道把候选筛得只剩正例的前置闸会把基线推到 90% 以上，此时「正命中率 ≥ 90%」
 * 任何打分器都能靠「什么都放行」达标，报出来是漂亮的 100% 命中率。
 * 那不是判别力，是门槛失效。这个坑我踩过一次（④ 以 ③ 为条件那一轮）。
 */
export function bestHitAtPrecision(
	points: ReadonlyArray<OperatingPoint>,
	labels: ReadonlyArray<number>,
	floor: number,
): OperatingPoint | "baseline-already-passes" | null {
	const baseline = labels.filter(l => l === 1).length / labels.length;
	if (floor <= baseline) return "baseline-already-passes";
	const ok = points.filter(p => p.precision >= floor);
	if (ok.length === 0) return null;
	return ok.reduce((a, b) => (b.hit > a.hit ? b : a));
}

/**
 * 错误数最少的阈值**区间**，不是一个点。
 *
 * 返回区间是因为分数分布常常是双峰的，中间一大段空隙里任何阈值都给同样的错误数 ——
 * 实测 bge 问↔答在 18 对上的平台宽 0.62。把它报成单个「最优 θ」会让人以为那个位置
 * 是测出来的，而其实这份数据定不出位置。
 */
export function bestThresholdBand(
	scores: ReadonlyArray<number>,
	labels: ReadonlyArray<number>,
	idx: ReadonlyArray<number> = scores.map((_, i) => i),
): { lo: number; hi: number; errors: number } {
	const uniq = [...new Set(idx.map(i => scores[i]))].sort((x, y) => x - y);
	const cuts = [0, ...uniq.flatMap((s, k) => (k + 1 < uniq.length ? [(s + uniq[k + 1]) / 2] : [])), 1];
	let least = Number.POSITIVE_INFINITY;
	const winners: Array<number> = [];
	for (const t of cuts) {
		let e = 0;
		for (const i of idx) if (labels[i] === 1 ? scores[i] < t : scores[i] >= t) e++;
		if (e < least) {
			least = e;
			winners.length = 0;
		}
		if (e === least) winners.push(t);
	}
	return { lo: Math.min(...winners), hi: Math.max(...winners), errors: least };
}

export function pct(x: number): string {
	return `${(x * 100).toFixed(1)}%`;
}
