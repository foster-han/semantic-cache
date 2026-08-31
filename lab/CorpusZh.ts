import type { ComposeChunk, CourseDoc, LabScenario, RerankProbe } from "./types/Corpus.ts";

/**
 * 场景：老师上传这学期一门课的资料，学生针对这门课问各种各样的问题。
 *
 * 前两版都跑偏了：
 *   v1 用「怎么重置密码」「James Bond 是真人吗」—— 跟学生和学科资料没关系
 *   v2 搭了六门课、跨课复用 —— 但一个学生只在一门课里，跨课复用根本不会发生
 *
 * 这一版只有**一门课**：ML101 机器学习导论，语料是老师上传的大纲、讲义、作业说明。
 * 缓存 scope 默认是 course（全班共享），这正是父 ADR 说的「跨学生缓存」。
 *
 * 单门课比跨课**更难测**：所有问题都在同一套学科词汇里，召回和重排的区分难度高得多。
 */

export const COURSE: string = "ml101";

export const DOCS: ReadonlyArray<CourseDoc> = [
	/* ---------- 老师上传的课程大纲与课务 ---------- */
	{ id: "syl", course: COURSE, unit: "大纲", title: "课程大纲与评分构成", version: 1,
	  text: "本课程共十六周。评分构成为：平时作业百分之三十、期中考试百分之三十、期末项目百分之四十。期中考试范围为第一章至第六章，闭卷，允许带一张 A4 手写公式纸。" },
	{ id: "hw-rule", course: COURSE, unit: "课务", title: "作业提交与迟交规则", version: 1,
	  text: "作业统一在课程网站提交 PDF 与代码压缩包，截止时间为每周日 23:59。迟交一天内按百分之八十计分，超过一天不再接收。三次作业中最低的一次按百分之五十计入总分。" },
	{ id: "faq", course: COURSE, unit: "课务", title: "常见问题", version: 1,
	  text: "答疑通过课程论坛进行，助教承诺两个工作日内回复。作业分数在批改完成后一周内公布在课程网站的个人成绩页，成绩只对本人可见。对分数有异议请在公布后五个工作日内提出复核。" },

	/* ---------- 讲义：基础 ---------- */
	{ id: "n1", course: COURSE, unit: "第一章", title: "监督学习与无监督学习", version: 1,
	  text: "监督学习从带标注的样本中学习输入到输出的映射，典型任务是分类与回归。无监督学习没有标注，目标是发现数据本身的结构，典型任务是聚类与降维。" },
	{ id: "n2", course: COURSE, unit: "第二章", title: "损失函数", version: 1,
	  text: "损失函数衡量单个样本预测与真实值的差距。回归常用平方损失和绝对值损失，分类常用交叉熵损失。经验风险是训练集上损失的平均。" },
	{ id: "n3", course: COURSE, unit: "第三章", title: "梯度下降", version: 1,
	  text: "梯度下降沿负梯度方向迭代更新参数。学习率过大会在最优点附近来回震荡甚至发散，过小则更新缓慢。小批量梯度下降在稳定性和速度之间折中。" },
	{ id: "n4", course: COURSE, unit: "第三章", title: "梯度下降的收敛", version: 1,
	  text: "这一章讲的收敛指的是优化过程的收敛：损失随迭代逐渐趋于平稳、不再明显下降。损失反复震荡通常是学习率过大，损失长期不降则可能是学习率过小或梯度消失。" },

	/* ---------- 讲义：拟合与正则 ---------- */
	{ id: "n5", course: COURSE, unit: "第四章", title: "过拟合", version: 1,
	  text: "过拟合指模型在训练集上表现很好但在验证集上明显变差，说明模型把训练数据里的噪声也学了进去。典型信号是训练误差持续下降而验证误差开始回升。" },
	{ id: "n6", course: COURSE, unit: "第四章", title: "欠拟合", version: 1,
	  text: "欠拟合指模型在训练集上就学不好，训练误差和验证误差都居高不下，说明模型容量不足或特征表达能力不够。典型信号是两条误差曲线都平在高位。" },
	{ id: "n7", course: COURSE, unit: "第四章", title: "偏差与方差", version: 1,
	  text: "偏差衡量模型预测的系统性误差，高偏差对应欠拟合；方差衡量模型对训练集扰动的敏感程度，高方差对应过拟合。两者通常此消彼长，需要权衡。" },
	{ id: "n8", course: COURSE, unit: "第五章", title: "L1 与 L2 正则化", version: 1,
	  text: "L1 正则化在损失里加上参数绝对值之和，倾向于产生稀疏解，可以顺带做特征选择。L2 正则化加参数平方和，倾向于让所有参数整体变小但不会恰好为零。" },
	{ id: "n9", course: COURSE, unit: "第五章", title: "早停与数据增强", version: 1,
	  text: "早停在验证误差开始回升时停止训练，是一种隐式正则化。数据增强通过对训练样本做保持标签不变的变换来扩充数据，同样能抑制过拟合。" },

	/* ---------- 讲义：评估 ---------- */
	{ id: "n10", course: COURSE, unit: "第六章", title: "准确率", version: 1,
	  text: "准确率是预测正确的样本占全部样本的比例。在类别极不平衡时准确率具有误导性：全部预测成多数类也能得到很高的准确率。" },
	{ id: "n11", course: COURSE, unit: "第六章", title: "精确率与召回率", version: 1,
	  text: "精确率是预测为正的样本中真正为正的比例，关注的是「报出来的有多少是对的」。召回率是真实为正的样本中被预测为正的比例，关注的是「该报的漏了多少」。两者通常此消彼长。" },
	{ id: "n12", course: COURSE, unit: "第六章", title: "F1 与 ROC-AUC", version: 1,
	  text: "F1 是精确率与召回率的调和平均，适合在两者都重要时做单一指标。ROC-AUC 衡量模型在各种阈值下区分正负例的能力，对类别不平衡相对不敏感。" },
	{ id: "n13", course: COURSE, unit: "第六章", title: "交叉验证", version: 1,
	  text: "k 折交叉验证把训练数据切成 k 份轮流做验证集，用平均表现估计泛化能力，比单次划分更稳定。数据量小的时候尤其值得用。" },

	/* ---------- 讲义：特征与进阶 ---------- */
	{ id: "n14", course: COURSE, unit: "第七章", title: "特征归一化", version: 1,
	  text: "这一章说的归一化指特征缩放：把不同量纲的特征映射到可比区间，常用 min-max 缩放和 z-score 标准化。不做的话量纲大的特征会主导距离计算。" },
	{ id: "n15", course: COURSE, unit: "第七章", title: "类别特征编码", version: 1,
	  text: "独热编码把类别特征展开成若干个零一列，适合类别数不多的情况。目标编码用该类别下标签的统计量替代类别，需要小心信息泄露。" },
	{ id: "n16", course: COURSE, unit: "第十章", title: "批归一化", version: 1,
	  text: "这一章说的归一化指批归一化：在网络内部对每个小批量的激活做标准化，再用可学习的缩放和偏移还原表达能力。它稳定了训练，也允许用更大的学习率，与第七章的特征缩放不是一回事。" },
	{ id: "n17", course: COURSE, unit: "第十一章", title: "EM 算法的收敛", version: 1,
	  text: "这一章说的收敛指 EM 算法的收敛性：每次迭代都不会降低似然，因此必然收敛到似然函数的一个驻点，但不保证是全局最优。与第三章梯度下降的收敛是两个不同的讨论。" },
	{ id: "n18", course: COURSE, unit: "第八章", title: "决策树与剪枝", version: 1,
	  text: "决策树通过递归划分特征空间来做预测，划分准则常用信息增益或基尼系数。不加限制的树很容易过拟合，需要通过预剪枝或后剪枝控制复杂度。" },
	{ id: "n19", course: COURSE, unit: "第九章", title: "集成方法", version: 1,
	  text: "装袋通过对数据重采样训练多个模型再平均，主要降低方差；提升串行训练模型让后一个纠正前一个的错误，主要降低偏差。随机森林属于装袋，梯度提升树属于提升。" },

	/* ---------- 讲义：方法史（人名是正当的学科内容） ---------- */
	{ id: "h1", course: COURSE, unit: "第十二章", title: "Hinton 与反向传播", version: 1,
	  text: "Hinton 与 Rumelhart、Williams 在 1986 年的工作让反向传播成为训练多层网络的通用方法，核心是用链式法则把误差逐层回传，从而高效地算出每个参数的梯度。" },
	{ id: "h2", course: COURSE, unit: "第十二章", title: "LeCun 与卷积网络", version: 1,
	  text: "LeCun 在手写数字识别上提出了卷积网络，核心是局部连接、权值共享和下采样，让模型对平移具有一定不变性，同时大幅减少参数量。" },
	{ id: "h3", course: COURSE, unit: "第十二章", title: "Vapnik 与支持向量机", version: 1,
	  text: "Vapnik 提出的支持向量机以最大化间隔为目标，通过核技巧把线性可分的思路推广到非线性情形，在深度学习兴起之前是主流的分类方法。" },
	{ id: "h4", course: COURSE, unit: "第十二章", title: "Breiman 与随机森林", version: 1,
	  text: "Breiman 提出了装袋与随机森林，通过对样本和特征双重随机化来降低单棵决策树的方差，是集成方法里最常用的基线之一。" },

	/* ---------- 作业说明 ---------- */
	{ id: "hw1", course: COURSE, unit: "作业一", title: "作业一：线性回归", version: 1,
	  text: "作业一要求手写实现最小二乘线性回归与梯度下降两种求解方式，并在给定数据集上比较收敛速度。需要提交推导过程、代码和一页实验报告。" },
	{ id: "hw2", course: COURSE, unit: "作业二", title: "作业二：正则化与调参", version: 1,
	  text: "作业二要求在同一数据集上比较无正则化、L1 与 L2 三种设置，画出验证误差随正则化强度变化的曲线，并解释观察到的过拟合与欠拟合区间。评分点包括曲线正确性、解释合理性和代码可复现性。" },
	{ id: "hw3", course: COURSE, unit: "作业三", title: "作业三：分类与评估", version: 1,
	  text: "作业三在一个类别不平衡的数据集上训练分类器，要求报告准确率、精确率、召回率、F1 和 ROC-AUC，并讨论为什么准确率在这个数据集上不是好指标。" },
];

/** 老师学期中改了大纲：期中范围扩大、闭卷改开卷。学期中最常见的一次语料更新。 */
export const SYL_V2: string =
	"本课程共十六周。评分构成调整为：平时作业百分之二十、期中考试百分之三十、期末项目百分之五十。期中考试范围扩大到第一章至第九章，新增集成方法一章，改为开卷，可带教材与笔记但不得使用电子设备。";

/**
 * 匿名化的实体表。
 *
 * **个人成绩不在这里，也不在语料里。**「李四的作业二得了多少分」不是 RAG 问题，
 * 是结构化查询 + 授权检查，应当由意图路由送去工具、由授权层判定学生 A 无权查
 * 学生 B —— LLM 和缓存都不该看见它。把个人数据放进可检索语料本身就是架构错误，
 * PII 门控和回答校验都只是在替这个错误打补丁。
 *
 * 实体塌陷本身没有消失，只是载体变了：合法的载体是**学科内容里本来就有的人名**。
 * 一门 ML 课的历史章节讲反向传播和卷积网络，学生问「Hinton 提出了什么方法？」
 * 和「LeCun 提出了什么方法？」都是正当的 RAG 问题，语料里也正当地含有这些人名 ——
 * 匿名化后它们同样塌成同一句。
 */
export const ENTITIES: ReadonlyArray<string> = ["Hinton", "辛顿", "LeCun", "杨立昆", "Vapnik", "Breiman"];

/** 不再有个人数据源。保留空对象只为兼容既有接线。 */
export const STUDENT_RECORDS: Readonly<Record<string, string>> = {};

/**
 * 干扰缓存：跑用例之前先灌进去，让 ③ 的 top-5 真的有东西可排。
 * 全部是这门课的学生会问的问题。
 */
export const DISTRACTORS: ReadonlyArray<string> = [
	"监督学习和无监督学习的区别是什么？",
	"交叉熵损失为什么适合分类？",
	"平方损失和绝对值损失有什么不同？",
	"经验风险是什么意思？",
	"学习率应该怎么选？",
	"小批量和全批量梯度下降哪个更好？",
	"梯度消失是怎么回事？",
	"为什么要用验证集而不是直接看训练误差？",
	"早停算正则化吗？",
	"数据增强适用于哪些场景？",
	"L1 为什么会产生稀疏解？",
	"正则化强度怎么调？",
	"k 折交叉验证的 k 取多少合适？",
	"留一法交叉验证代价为什么高？",
	"F1 分数怎么算？",
	"ROC 曲线怎么画？",
	"AUC 是什么意思？",
	"类别不平衡怎么处理？",
	"独热编码和目标编码怎么选？",
	"目标编码为什么会信息泄露？",
	"决策树用信息增益还是基尼系数？",
	"预剪枝和后剪枝有什么区别？",
	"随机森林和梯度提升树的区别？",
	"装袋为什么能降低方差？",
	"作业一要提交哪些东西？",
	"作业三要报告哪些指标？",
	"期末项目占多少分？",
	"作业迟交怎么扣分？",
	"答疑在哪里进行？",
	"成绩什么时候公布？",
];

/**
 * 带标注的用例。全部在这一门课里。
 *
 * **判据是 expectDoc，不是 reuse/regenerate。**
 * 一开始按「该不该重生成」判，但加了干扰缓存之后这个判据就错了：探测问题可能
 * 命中另一条**内容正确**的缓存，那是成功不是失败。真正要判的是「返回给学生的
 * 答案是不是基于正确的那篇资料」。
 *
 *   expectDoc —— 答案必须基于哪篇资料（rec:X 表示某个学生的个人成绩记录）
 *   expect    —— 顺带记录预期的复用行为，只作参考不作判据
 *   catches   —— 期望由哪道闸拦下
 */
/**
 * ④ 的判别力探针。**问句全部取自这门课**，不是通用例子 —— 先前用的是
 * 「怎么重置密码 / 忘记密码了怎么办」，那正是 v1 语料被废弃的理由（跟学科资料无关），
 * 拿它测出来的判别力说明不了这个重排器在本语料上够不够用。
 *
 * 判据是 margin（正例最低 − 负例最高），不是跨度：跨度大但顺序反的模型毫无用处。
 */
export const RERANK_PROBES: ReadonlyArray<RerankProbe> = [
	{ label: "同义改写（该高）", a: "什么是过拟合？", b: "过拟合是什么意思？", bDoc: "n5", shouldMatch: true },
	{ label: "逐字相同（该高）", a: "什么是过拟合？", b: "什么是过拟合？", bDoc: "n5", shouldMatch: true },
	{ label: "近义反义（该低）", a: "什么是过拟合？", b: "什么是欠拟合？", bDoc: "n6", shouldMatch: false },
	{ label: "同主题不同问（该低）", a: "什么是过拟合？", b: "正则化强度怎么调？", bDoc: "n8", shouldMatch: false },
	{ label: "完全无关（该低）", a: "什么是过拟合？", b: "成绩什么时候公布？", bDoc: "faq", shouldMatch: false },
];

export const SCENARIOS: ReadonlyArray<LabScenario> = [
	/* ---- 正例：缓存本来就该吃下的 ---- */
	{
		key: "para-overfit",
		expectDoc: "n5",
		label: "同义改写 · 过拟合",
		note: "同一个意图的两种问法",
		seed: { text: "什么是过拟合？", user: "s1", unit: "第四章" },
		probe: { text: "过拟合是什么意思？", user: "s2", unit: "第四章" },
		expect: "reuse",
	},
	{
		key: "para-lr",
		expectDoc: "n3",
		label: "同义改写 · 学习率",
		note: "口语化的另一种问法",
		seed: { text: "学习率太大会怎么样？", user: "s1", unit: "第三章" },
		probe: { text: "学习率设得过大有什么后果？", user: "s3", unit: "第三章" },
		expect: "reuse",
	},
	{
		key: "para-cv",
		expectDoc: "n13",
		label: "同义改写 · 交叉验证",
		note: "问法差得比较远，但仍是同一个意图",
		seed: { text: "为什么要做 k 折交叉验证？", user: "s1", unit: "第六章" },
		probe: { text: "交叉验证有什么用？", user: "s4", unit: "第六章" },
		expect: "reuse",
	},

	{
		key: "para-bias",
		expectDoc: "n7",
		label: "同义改写 · 偏差方差",
		note: "术语问法 vs 大白话问法",
		seed: { text: "偏差和方差是什么关系？", user: "s1", unit: "第四章" },
		probe: { text: "偏差方差怎么权衡？", user: "s2", unit: "第四章" },
		expect: "reuse",
	},
	{
		key: "para-norm",
		expectDoc: "n14",
		label: "同义改写 · 特征归一化",
		note: "「怎么做」和「为什么要做」——意图相同，措辞几乎不重叠",
		seed: { text: "特征归一化怎么做？", user: "s1", unit: "第七章" },
		probe: { text: "为什么要对特征做归一化？", user: "s3", unit: "第七章" },
		expect: "reuse",
	},
	{
		key: "para-prune",
		expectDoc: "n18",
		label: "同义改写 · 剪枝",
		note: "口语「砍枝」vs 术语「剪枝」",
		seed: { text: "决策树为什么要剪枝？", user: "s1", unit: "第八章" },
		probe: { text: "剪枝是为了解决什么问题？", user: "s4", unit: "第八章" },
		expect: "reuse",
	},
	{
		key: "para-early",
		expectDoc: "n9",
		label: "同义改写 · 早停",
		note: "「什么时候停」是学生实际会用的问法",
		seed: { text: "早停是怎么回事？", user: "s1", unit: "第五章" },
		probe: { text: "训练什么时候该停下来？", user: "s2", unit: "第五章" },
		expect: "reuse",
	},
	{
		key: "para-f1",
		expectDoc: "n12",
		label: "同义改写 · F1",
		note: "缩写 vs 展开",
		seed: { text: "F1 分数是什么？", user: "s1", unit: "第六章" },
		probe: { text: "F1 怎么理解？", user: "s3", unit: "第六章" },
		expect: "reuse",
	},
	{
		key: "para-loss",
		expectDoc: "n2",
		label: "同义改写 · 损失函数",
		note: "「干什么用的」——最常见的初学者问法",
		seed: { text: "损失函数是干什么的？", user: "s1", unit: "第二章" },
		probe: { text: "为什么需要损失函数？", user: "s4", unit: "第二章" },
		expect: "reuse",
	},
	{
		key: "para-ensemble",
		expectDoc: "n19",
		label: "同义改写 · 集成方法",
		note: "「多个模型一起用」是不带术语的问法",
		seed: { text: "集成方法是什么？", user: "s1", unit: "第九章" },
		probe: { text: "为什么把多个模型合起来会更好？", user: "s2", unit: "第九章" },
		expect: "reuse",
	},

	/* ---- 近义反义对：单门课内最主要的假命中来源 ---- */
	{
		key: "anti-fit",
		expectDoc: "n6",
		label: "反义对 · 过拟合/欠拟合",
		note: "问法极像、概念相反，学生真的会连着问",
		seed: { text: "什么是过拟合？", user: "s1", unit: "第四章" },
		probe: { text: "什么是欠拟合？", user: "s2", unit: "第四章" },
		expect: "regenerate",
		catches: [3, 4],
	},
	{
		key: "anti-pr",
		expectDoc: "n11",
		label: "反义对 · 精确率/召回率",
		note: "两个指标名字只差一个词",
		seed: { text: "精确率是什么？", user: "s1", unit: "第六章" },
		probe: { text: "召回率是什么？", user: "s2", unit: "第六章" },
		expect: "regenerate",
		catches: [3, 4],
	},
	{
		key: "anti-l1l2",
		expectDoc: "n8",
		label: "反义对 · L1/L2",
		note: "同一节里的两个东西，问法只差一个字符",
		seed: { text: "L1 正则化有什么特点？", user: "s1", unit: "第五章" },
		probe: { text: "L2 正则化有什么特点？", user: "s2", unit: "第五章" },
		expect: "regenerate",
		catches: [3, 4],
	},

	/* ---- 课内跨章：同一个词在两章里指不同东西 ---- */
	{
		key: "unit-norm",
		expectDoc: "n16",
		label: "课内跨章 · 归一化",
		note: "第七章的特征缩放 vs 第十章的批归一化。前提：产品知道学生当前学到哪一章",
		caveat: "没有「学生当前章节」这个上下文时，两条输入完全相同，复用其实是对的 —— 那时它不是缓存问题，而是检索歧义。",
		seed: { text: "归一化是怎么做的？", user: "s1", unit: "第七章" },
		probe: { text: "归一化是怎么做的？", user: "s2", unit: "第十章" },
		expect: "regenerate",
		catches: 6,
	},
	{
		key: "unit-conv",
		expectDoc: "n17",
		label: "课内跨章 · 收敛",
		note: "第三章梯度下降的收敛 vs 第十一章 EM 的收敛。同样依赖「当前章节」上下文",
		caveat: "同上：没有章节上下文时这不算缓存失效。",
		seed: { text: "收敛是什么意思？", user: "s1", unit: "第三章" },
		probe: { text: "收敛是什么意思？", user: "s2", unit: "第十一章" },
		expect: "regenerate",
		catches: 6,
	},

	/* ---- 实体塌陷：学科内容里的人名（正当的 RAG 问题）---- */
	{
		key: "entity-method",
		expectDoc: "h2",
		label: "实体塌陷 · 方法史",
		note: "匿名化后同样塌成一句，但两者都是正当的学科问题",
		seed: { text: "Hinton 提出了什么方法？", user: "s1", unit: "第十二章" },
		probe: { text: "LeCun 提出了什么方法？", user: "s2", unit: "第十二章" },
		expect: "regenerate",
		catches: 6,
	},
	{
		key: "entity-method2",
		expectDoc: "h4",
		label: "实体塌陷 · 方法史 2",
		note: "同上，换一对",
		seed: { text: "Vapnik 提出了什么方法？", user: "s3", unit: "第十二章" },
		probe: { text: "Breiman 提出了什么方法？", user: "s4", unit: "第十二章" },
		expect: "regenerate",
		catches: 6,
	},

	/* ---- 语料改版 ---- */
	{
		key: "staleness-syllabus",
		expectDoc: "syl",
		label: "语料改版 · 期中范围",
		note: "老师学期中改了大纲：范围扩大、闭卷改开卷",
		seed: { text: "期中考试考到第几章？", user: "s1", unit: "大纲" },
		bumpCorpus: true,
		probe: { text: "期中考试考到第几章？", user: "s2", unit: "大纲" },
		expect: "regenerate",
		catches: 5,
	},
	{
		key: "staleness-grade",
		expectDoc: "syl",
		label: "语料改版 · 评分构成",
		note: "评分权重也一起改了，问法不同但依赖同一篇大纲",
		seed: { text: "平时作业占总分多少？", user: "s1", unit: "大纲" },
		bumpCorpus: true,
		probe: { text: "平时作业占总分多少？", user: "s2", unit: "大纲" },
		expect: "regenerate",
		catches: 5,
	},

	/* ---- 对照组：完全无关 ---- */
	{
		key: "neg-unrelated",
		expectDoc: "hw3",
		label: "对照组 · 无关主题",
		note: "同一门课的两个远主题，③ 就该拦住",
		seed: { text: "决策树怎么剪枝？", user: "s1", unit: "第八章" },
		probe: { text: "作业三要报告哪些指标？", user: "s2", unit: "第八章" },
		expect: "regenerate",
		catches: [3, 4],
	},

	{
		key: "anti-acc-prec",
		expectDoc: "n11",
		label: "近义对 · 准确率/精确率",
		note: "两个词差一个字，住在不同文档里 —— 判据够得着",
		seed: { text: "准确率是什么？", user: "s1", unit: "第六章" },
		probe: { text: "精确率是什么？", user: "s2", unit: "第六章" },
		expect: "regenerate",
		catches: [3, 4],
	},
	{
		key: "anti-early-prune",
		expectDoc: "n18",
		label: "近义对 · 早停/剪枝",
		note: "都是「防过拟合的手段」，问法极像，分属第五章和第八章",
		seed: { text: "早停怎么防止过拟合？", user: "s1", unit: "第五章" },
		probe: { text: "剪枝怎么防止过拟合？", user: "s2", unit: "第八章" },
		expect: "regenerate",
		catches: [3, 4, 6],
	},
	{
		key: "anti-tree-ensemble",
		expectDoc: "n19",
		label: "近义对 · 决策树/集成",
		note: "一个是单模型一个是多模型，学生常混",
		seed: { text: "决策树是怎么工作的？", user: "s1", unit: "第八章" },
		probe: { text: "集成方法是怎么工作的？", user: "s2", unit: "第九章" },
		expect: "regenerate",
		catches: [3, 4],
	},
	{
		key: "anti-norm-encode",
		expectDoc: "n15",
		label: "近义对 · 归一化/编码",
		note: "同属第七章特征工程，都是「特征要先处理一下」",
		seed: { text: "数值特征要怎么预处理？", user: "s1", unit: "第七章" },
		probe: { text: "类别特征要怎么预处理？", user: "s2", unit: "第七章" },
		expect: "regenerate",
		catches: [3, 4, 6],
	},
	{
		key: "entity-method3",
		expectDoc: "h3",
		label: "实体塌陷 · Hinton/Vapnik",
		note: "第三对人名，扩大实体用例的样本",
		seed: { text: "Hinton 提出了什么方法？", user: "s1", unit: "第十二章" },
		probe: { text: "Vapnik 提出了什么方法？", user: "s2", unit: "第十二章" },
		expect: "regenerate",
		catches: 6,
	},
	{
		key: "entity-method4",
		expectDoc: "h4",
		label: "实体塌陷 · LeCun/Breiman",
		note: "第四对人名",
		seed: { text: "LeCun 提出了什么方法？", user: "s1", unit: "第十二章" },
		probe: { text: "Breiman 提出了什么方法？", user: "s2", unit: "第十二章" },
		expect: "regenerate",
		catches: 6,
	},
];

/** 拼答案。模板语言必须与语料语言一致 —— 混语会系统性压低 ⑥ 的支撑度。 */
export function compose(chunks: ReadonlyArray<ComposeChunk>): string {
	if (chunks.length === 0) return "（本课程下没有可用资料）";
	const top = chunks[0];
	const sentences = top.text.split(/(?<=。)/u).filter(Boolean);
	const lead = sentences[0] ?? top.text;
	const rest = sentences.slice(1).join("");
	const also = chunks[1] ? `\n\n另外可以对照《${chunks[1].title}》一起看。` : "";
	return `简单说：${lead}${rest ? `\n\n展开一点：${rest}` : ""}${also}\n\n（依据：《${top.title}》v${top.version}）`;
}

export function refineSuffix(title: string): string {
	return `\n（已按本次检索到的《${title}》微调）`;
}
