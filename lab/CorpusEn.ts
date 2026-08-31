import type { ComposeChunk, CourseDoc, LabScenario, RerankProbe } from "./types/Corpus.ts";

/**
 * English mirror of the ML101 corpus. Same course, same failure classes,
 * so the two languages are directly comparable.
 */

export const COURSE: string = "ml101";

export const DOCS: ReadonlyArray<CourseDoc> = [
	{ id: "syl", course: COURSE, unit: "Syllabus", title: "Syllabus and Grading", version: 1,
	  text: "The course runs sixteen weeks. Grading is thirty percent homework, thirty percent midterm, forty percent final project. The midterm covers chapters one through six, closed book, one A4 sheet of handwritten notes allowed." },
	{ id: "hw-rule", course: COURSE, unit: "Policies", title: "Submission and Late Policy", version: 1,
	  text: "Homework is submitted on the course site as a PDF plus a code archive, due Sunday at 23:59. Work up to one day late receives eighty percent credit; after one day it is not accepted. The lowest of the three homework scores counts at fifty percent." },
	{ id: "faq", course: COURSE, unit: "Policies", title: "Frequently Asked Questions", version: 1,
	  text: "Questions go to the course forum and teaching assistants reply within two working days. Homework scores appear on your personal grade page within one week of grading and are visible only to you. Regrade requests must be filed within five working days." },

	{ id: "n1", course: COURSE, unit: "Chapter 1", title: "Supervised and Unsupervised Learning", version: 1,
	  text: "Supervised learning maps inputs to outputs from labelled examples; the usual tasks are classification and regression. Unsupervised learning has no labels and looks for structure in the data itself, typically clustering and dimensionality reduction." },
	{ id: "n2", course: COURSE, unit: "Chapter 2", title: "Loss Functions", version: 1,
	  text: "A loss function measures the gap between a prediction and the truth for one example. Regression commonly uses squared or absolute loss, classification uses cross-entropy. Empirical risk is the average loss over the training set." },
	{ id: "n3", course: COURSE, unit: "Chapter 3", title: "Gradient Descent", version: 1,
	  text: "Gradient descent updates parameters along the negative gradient. A learning rate that is too large makes the loss oscillate around the optimum or diverge outright; too small and progress is painfully slow. Mini-batch descent trades stability against speed." },
	{ id: "n4", course: COURSE, unit: "Chapter 3", title: "Convergence of Gradient Descent", version: 1,
	  text: "Convergence in this chapter means the optimisation settling down: the loss flattens out and stops decreasing meaningfully. Loss that keeps bouncing usually means the learning rate is too high; loss that never drops points to a rate that is too low or to vanishing gradients." },

	{ id: "n5", course: COURSE, unit: "Chapter 4", title: "Overfitting", version: 1,
	  text: "Overfitting is when a model does well on the training set but clearly worse on validation, meaning it has memorised noise in the training data. The signature is training error still falling while validation error starts climbing back up." },
	{ id: "n6", course: COURSE, unit: "Chapter 4", title: "Underfitting", version: 1,
	  text: "Underfitting is when the model cannot even fit the training set: training and validation error are both stuck high, meaning the model lacks capacity or the features lack expressive power. The signature is both error curves flat and high." },
	{ id: "n7", course: COURSE, unit: "Chapter 4", title: "Bias and Variance", version: 1,
	  text: "Bias measures systematic error in a model's predictions and high bias corresponds to underfitting. Variance measures sensitivity to perturbations of the training set and high variance corresponds to overfitting. The two usually trade off against each other." },
	{ id: "n8", course: COURSE, unit: "Chapter 5", title: "L1 and L2 Regularisation", version: 1,
	  text: "L1 regularisation adds the sum of absolute parameter values to the loss and tends to produce sparse solutions, which doubles as feature selection. L2 adds the sum of squares and tends to shrink every parameter toward zero without any reaching exactly zero." },
	{ id: "n9", course: COURSE, unit: "Chapter 5", title: "Early Stopping and Data Augmentation", version: 1,
	  text: "Early stopping halts training when validation error begins to rise and acts as implicit regularisation. Data augmentation expands the training set with label-preserving transformations and likewise suppresses overfitting." },

	{ id: "n10", course: COURSE, unit: "Chapter 6", title: "Accuracy", version: 1,
	  text: "Accuracy is the fraction of examples predicted correctly. Under severe class imbalance accuracy is misleading: predicting the majority class every time already scores very high." },
	{ id: "n11", course: COURSE, unit: "Chapter 6", title: "Precision and Recall", version: 1,
	  text: "Precision is the fraction of predicted positives that are truly positive, so it asks how many of the alarms were real. Recall is the fraction of true positives that were predicted positive, so it asks how many real cases were missed. The two usually trade off." },
	{ id: "n12", course: COURSE, unit: "Chapter 6", title: "F1 and ROC-AUC", version: 1,
	  text: "F1 is the harmonic mean of precision and recall and works as a single number when both matter. ROC-AUC measures the ability to separate positives from negatives across thresholds and is relatively insensitive to class imbalance." },
	{ id: "n13", course: COURSE, unit: "Chapter 6", title: "Cross-Validation", version: 1,
	  text: "K-fold cross-validation splits the training data into k parts that take turns as the validation set, estimating generalisation from the average. It is more stable than a single split and especially worth it when data is scarce." },

	{ id: "n14", course: COURSE, unit: "Chapter 7", title: "Feature Normalisation", version: 1,
	  text: "Normalisation in this chapter means feature scaling: mapping features with different units onto a comparable range, usually by min-max scaling or z-score standardisation. Skip it and features with large magnitudes dominate any distance computation." },
	{ id: "n15", course: COURSE, unit: "Chapter 7", title: "Encoding Categorical Features", version: 1,
	  text: "One-hot encoding expands a categorical feature into several zero-one columns and suits a small number of categories. Target encoding replaces the category with a statistic of the label and must be handled carefully to avoid leakage." },
	{ id: "n16", course: COURSE, unit: "Chapter 10", title: "Batch Normalisation", version: 1,
	  text: "Normalisation in this chapter means batch normalisation: standardising activations inside the network per mini-batch, then restoring expressiveness with a learnable scale and shift. It stabilises training and permits larger learning rates, and is not the same thing as the feature scaling of chapter seven." },
	{ id: "n17", course: COURSE, unit: "Chapter 11", title: "Convergence of EM", version: 1,
	  text: "Convergence in this chapter means the convergence of the EM algorithm: each iteration cannot decrease the likelihood, so the procedure necessarily converges to a stationary point of the likelihood, though not necessarily a global optimum. This is a different discussion from gradient descent in chapter three." },
	{ id: "n18", course: COURSE, unit: "Chapter 8", title: "Decision Trees and Pruning", version: 1,
	  text: "A decision tree predicts by recursively partitioning the feature space, splitting on information gain or Gini impurity. An unconstrained tree overfits readily, so complexity is controlled by pre-pruning or post-pruning." },
	{ id: "n19", course: COURSE, unit: "Chapter 9", title: "Ensemble Methods", version: 1,
	  text: "Bagging resamples the data, trains several models and averages them, mainly reducing variance. Boosting trains models in sequence so each corrects its predecessor, mainly reducing bias. Random forests are bagging; gradient boosted trees are boosting." },

	{ id: "h1", course: COURSE, unit: "Chapter 12", title: "Hinton and Backpropagation", version: 1,
	  text: "Hinton, with Rumelhart and Williams, made backpropagation the general method for training multi-layer networks in 1986. The idea is to push error backwards layer by layer with the chain rule, which computes every parameter's gradient efficiently." },
	{ id: "h2", course: COURSE, unit: "Chapter 12", title: "LeCun and Convolutional Networks", version: 1,
	  text: "LeCun introduced convolutional networks for handwritten digit recognition. The ingredients are local connectivity, weight sharing and subsampling, which buy some translation invariance while cutting the parameter count sharply." },
	{ id: "h3", course: COURSE, unit: "Chapter 12", title: "Vapnik and Support Vector Machines", version: 1,
	  text: "Vapnik proposed the support vector machine, which maximises the margin between classes and uses the kernel trick to carry a linear formulation into non-linear settings. It was the mainstream classifier before deep learning took over." },
	{ id: "h4", course: COURSE, unit: "Chapter 12", title: "Breiman and Random Forests", version: 1,
	  text: "Breiman proposed bagging and random forests, randomising over both examples and features to cut the variance of a single decision tree. Random forests remain one of the most used baselines among ensemble methods." },

	{ id: "hw1", course: COURSE, unit: "Homework 1", title: "Homework 1: Linear Regression", version: 1,
	  text: "Homework one asks you to implement least squares and gradient descent by hand and compare their convergence on a supplied dataset. Submit the derivation, the code and a one page report." },
	{ id: "hw2", course: COURSE, unit: "Homework 2", title: "Homework 2: Regularisation and Tuning", version: 1,
	  text: "Homework two compares no regularisation against L1 and L2 on one dataset, plots validation error against regularisation strength, and explains the overfitting and underfitting regions you observe. Marks cover curve correctness, quality of explanation and reproducibility of the code." },
	{ id: "hw3", course: COURSE, unit: "Homework 3", title: "Homework 3: Classification and Evaluation", version: 1,
	  text: "Homework three trains a classifier on an imbalanced dataset and asks you to report accuracy, precision, recall, F1 and ROC-AUC, then discuss why accuracy is a poor metric on this particular dataset." },
];

export const SYL_V2: string =
	"The course runs sixteen weeks. Grading has been revised to twenty percent homework, thirty percent midterm and fifty percent final project. The midterm now covers chapters one through nine, adding the ensemble methods chapter, and becomes open book: textbook and notes are allowed but no electronic devices.";

/**
 * Personal grades are deliberately absent from the corpus. "What did Bob score?"
 * is a structured lookup with an authorisation check, not a RAG question — it
 * belongs behind intent routing and an authz layer, never in the retrievable
 * corpus. Entity collapse still matters, but its legitimate carrier is a person
 * name that is genuine subject matter.
 */
export const ENTITIES: ReadonlyArray<string> = ["Hinton", "LeCun", "Vapnik", "Breiman"];

export const STUDENT_RECORDS: Readonly<Record<string, string>> = {};

export const DISTRACTORS: ReadonlyArray<string> = [
	"What is the difference between supervised and unsupervised learning?",
	"Why is cross-entropy suited to classification?",
	"How do squared loss and absolute loss differ?",
	"What does empirical risk mean?",
	"How should I pick a learning rate?",
	"Is mini-batch or full-batch gradient descent better?",
	"What causes vanishing gradients?",
	"Why use a validation set instead of just training error?",
	"Does early stopping count as regularisation?",
	"When is data augmentation appropriate?",
	"Why does L1 produce sparse solutions?",
	"How do I tune the regularisation strength?",
	"What value of k should I use for k-fold cross-validation?",
	"Why is leave-one-out cross-validation expensive?",
	"How is the F1 score computed?",
	"How do you plot an ROC curve?",
	"What does AUC actually measure?",
	"How do you handle class imbalance?",
	"Should I use one-hot or target encoding?",
	"Why does target encoding leak information?",
	"Should a decision tree split on information gain or Gini?",
	"What is the difference between pre-pruning and post-pruning?",
	"How do random forests differ from gradient boosted trees?",
	"Why does bagging reduce variance?",
	"What do I need to submit for homework one?",
	"Which metrics does homework three ask for?",
	"How much is the final project worth?",
	"What is the penalty for late homework?",
	"Where do I ask questions?",
	"When are grades released?",
];

/** ④ 的判别力探针。与中文那份一一对应，好让两种语言的 margin 直接比较。 */
export const RERANK_PROBES: ReadonlyArray<RerankProbe> = [
	{ label: "paraphrase (should MATCH)", a: "What is overfitting?", b: "What does overfitting mean?", bDoc: "n5", shouldMatch: true },
	{ label: "identical (should MATCH)", a: "What is overfitting?", b: "What is overfitting?", bDoc: "n5", shouldMatch: true },
	{ label: "near-antonym (should DIFFER)", a: "What is overfitting?", b: "What is underfitting?", bDoc: "n6", shouldMatch: false },
	{ label: "same topic (should DIFFER)", a: "What is overfitting?", b: "How do I tune regularisation strength?", bDoc: "n8", shouldMatch: false },
	{ label: "unrelated (should DIFFER)", a: "What is overfitting?", b: "When are grades released?", bDoc: "faq", shouldMatch: false },
];

export const SCENARIOS: ReadonlyArray<LabScenario> = [
	{ key: "para-overfit", expectDoc: "n5", label: "Paraphrase · overfitting", note: "Same intent, two phrasings",
	  seed: { text: "What is overfitting?", user: "s1", unit: "Chapter 4" },
	  probe: { text: "What does overfitting mean?", user: "s2", unit: "Chapter 4" }, expect: "reuse" },

	{ key: "para-lr", expectDoc: "n3", label: "Paraphrase · learning rate", note: "More colloquial phrasing",
	  seed: { text: "What happens if the learning rate is too large?", user: "s1", unit: "Chapter 3" },
	  probe: { text: "What goes wrong when you set the learning rate too high?", user: "s3", unit: "Chapter 3" }, expect: "reuse" },

	{ key: "para-cv", expectDoc: "n13", label: "Paraphrase · cross-validation", note: "Phrasings differ a lot, intent is the same",
	  seed: { text: "Why do we do k-fold cross-validation?", user: "s1", unit: "Chapter 6" },
	  probe: { text: "What is cross-validation good for?", user: "s4", unit: "Chapter 6" }, expect: "reuse" },

	{ key: "para-bias", expectDoc: "n7", label: "Paraphrase · bias/variance", note: "Textbook phrasing vs plain phrasing",
	  seed: { text: "How are bias and variance related?", user: "s1", unit: "Chapter 4" },
	  probe: { text: "How do you trade off bias against variance?", user: "s2", unit: "Chapter 4" }, expect: "reuse" },

	{ key: "para-norm", expectDoc: "n14", label: "Paraphrase · feature normalisation", note: "\"How\" vs \"why\" — same intent, almost no wording overlap",
	  seed: { text: "How do you normalise features?", user: "s1", unit: "Chapter 7" },
	  probe: { text: "Why should features be normalised?", user: "s3", unit: "Chapter 7" }, expect: "reuse" },

	{ key: "para-prune", expectDoc: "n18", label: "Paraphrase · pruning", note: "Colloquial \"cutting back\" vs the term \"pruning\"",
	  seed: { text: "Why do decision trees need pruning?", user: "s1", unit: "Chapter 8" },
	  probe: { text: "What problem does pruning solve?", user: "s4", unit: "Chapter 8" }, expect: "reuse" },

	{ key: "para-early", expectDoc: "n9", label: "Paraphrase · early stopping", note: "\"When to stop\" is how students actually ask",
	  seed: { text: "What is early stopping?", user: "s1", unit: "Chapter 5" },
	  probe: { text: "When should training be stopped?", user: "s2", unit: "Chapter 5" }, expect: "reuse" },

	{ key: "para-f1", expectDoc: "n12", label: "Paraphrase · F1", note: "Abbreviation vs spelled out",
	  seed: { text: "What is the F1 score?", user: "s1", unit: "Chapter 6" },
	  probe: { text: "How should F1 be interpreted?", user: "s3", unit: "Chapter 6" }, expect: "reuse" },

	{ key: "para-loss", expectDoc: "n2", label: "Paraphrase · loss function", note: "\"What is it for\" — the most common beginner phrasing",
	  seed: { text: "What is a loss function for?", user: "s1", unit: "Chapter 2" },
	  probe: { text: "Why do we need a loss function?", user: "s4", unit: "Chapter 2" }, expect: "reuse" },

	{ key: "para-ensemble", expectDoc: "n19", label: "Paraphrase · ensemble methods", note: "\"Several models together\" is the term-free phrasing",
	  seed: { text: "What are ensemble methods?", user: "s1", unit: "Chapter 9" },
	  probe: { text: "Why does combining several models work better?", user: "s2", unit: "Chapter 9" }, expect: "reuse" },

	{ key: "anti-fit", expectDoc: "n6", label: "Near-antonym · over/underfitting", note: "Near-identical phrasing, opposite concepts",
	  seed: { text: "What is overfitting?", user: "s1", unit: "Chapter 4" },
	  probe: { text: "What is underfitting?", user: "s2", unit: "Chapter 4" }, expect: "regenerate", catches: [3, 4] },

	{ key: "anti-pr", expectDoc: "n11", label: "Near-antonym · precision/recall", note: "Two metrics one word apart",
	  seed: { text: "What is precision?", user: "s1", unit: "Chapter 6" },
	  probe: { text: "What is recall?", user: "s2", unit: "Chapter 6" }, expect: "regenerate", catches: [3, 4] },

	{ key: "anti-l1l2", expectDoc: "n8", label: "Near-antonym · L1/L2", note: "One character apart",
	  seed: { text: "What are the properties of L1 regularisation?", user: "s1", unit: "Chapter 5" },
	  probe: { text: "What are the properties of L2 regularisation?", user: "s2", unit: "Chapter 5" }, expect: "regenerate", catches: [3, 4] },

	{ key: "unit-norm", expectDoc: "n16", label: "Same word, different chapter · normalisation",
	  note: "Chapter 7 feature scaling vs chapter 10 batch norm. Assumes the product knows which chapter the student is on",
	  caveat: "Without that chapter context the two inputs are identical and reuse is correct — then it is a retrieval ambiguity, not a cache failure.",
	  seed: { text: "How does normalisation work?", user: "s1", unit: "Chapter 7" },
	  probe: { text: "How does normalisation work?", user: "s2", unit: "Chapter 10" }, expect: "regenerate", catches: 6 },

	{ key: "unit-conv", expectDoc: "n17", label: "Same word, different chapter · convergence",
	  note: "Gradient descent in chapter 3 vs EM in chapter 11",
	  caveat: "Same caveat as above.",
	  seed: { text: "What does convergence mean?", user: "s1", unit: "Chapter 3" },
	  probe: { text: "What does convergence mean?", user: "s2", unit: "Chapter 11" }, expect: "regenerate", catches: 6 },

	{ key: "entity-method", expectDoc: "h2", label: "Entity collapse · method history",
	  note: "Collapses to the same string after anonymisation, yet both are legitimate subject questions",
	  seed: { text: "What method did Hinton propose?", user: "s1", unit: "Chapter 12" },
	  probe: { text: "What method did LeCun propose?", user: "s2", unit: "Chapter 12" }, expect: "regenerate", catches: 6 },

	{ key: "entity-method2", expectDoc: "h4", label: "Entity collapse · method history 2", note: "Same, another pair",
	  seed: { text: "What method did Vapnik propose?", user: "s3", unit: "Chapter 12" },
	  probe: { text: "What method did Breiman propose?", user: "s4", unit: "Chapter 12" }, expect: "regenerate", catches: 6 },

	{ key: "staleness-syllabus", expectDoc: "syl", label: "Corpus revision · midterm scope",
	  note: "Instructor revises the syllabus mid-term: scope widens, closed book becomes open book",
	  seed: { text: "How many chapters does the midterm cover?", user: "s1", unit: "Syllabus" }, bumpCorpus: true,
	  probe: { text: "How many chapters does the midterm cover?", user: "s2", unit: "Syllabus" }, expect: "regenerate", catches: 5 },

	{ key: "staleness-grade", expectDoc: "syl", label: "Corpus revision · grade weights",
	  note: "Weights changed in the same revision; different question, same source document",
	  seed: { text: "What percentage of the grade is homework?", user: "s1", unit: "Syllabus" }, bumpCorpus: true,
	  probe: { text: "What percentage of the grade is homework?", user: "s2", unit: "Syllabus" }, expect: "regenerate", catches: 5 },

	{ key: "neg-unrelated", expectDoc: "hw3", label: "Control · unrelated topics", note: "Two distant topics in the same course",
	  seed: { text: "How do you prune a decision tree?", user: "s1", unit: "Chapter 8" },
	  probe: { text: "Which metrics does homework three ask for?", user: "s2", unit: "Chapter 8" }, expect: "regenerate", catches: [3, 4] },

	{ key: "anti-acc-prec", expectDoc: "n11", label: "Near-synonym · accuracy/precision", note: "One word apart, and they live in different documents — the criterion can see the error",
	  seed: { text: "What is accuracy?", user: "s1", unit: "Chapter 6" },
	  probe: { text: "What is precision?", user: "s2", unit: "Chapter 6" }, expect: "regenerate", catches: [3, 4] },

	{ key: "anti-early-prune", expectDoc: "n18", label: "Near-synonym · early stopping/pruning", note: "Both are \"ways to fight overfitting\", phrased almost identically, chapters 5 and 8",
	  seed: { text: "How does early stopping prevent overfitting?", user: "s1", unit: "Chapter 5" },
	  probe: { text: "How does pruning prevent overfitting?", user: "s2", unit: "Chapter 8" }, expect: "regenerate", catches: [3, 4, 6] },

	{ key: "anti-tree-ensemble", expectDoc: "n19", label: "Near-synonym · trees/ensembles", note: "One is a single model, one is many — students mix them up",
	  seed: { text: "How does a decision tree work?", user: "s1", unit: "Chapter 8" },
	  probe: { text: "How do ensemble methods work?", user: "s2", unit: "Chapter 9" }, expect: "regenerate", catches: [3, 4] },

	{ key: "anti-norm-encode", expectDoc: "n15", label: "Near-synonym · normalising/encoding", note: "Both are chapter-7 feature engineering: \"features need preprocessing first\"",
	  seed: { text: "How should numeric features be preprocessed?", user: "s1", unit: "Chapter 7" },
	  probe: { text: "How should categorical features be preprocessed?", user: "s2", unit: "Chapter 7" }, expect: "regenerate", catches: [3, 4, 6] },

	{ key: "entity-method3", expectDoc: "h3", label: "Placeholder collapse · Hinton/Vapnik", note: "Third name pair — more entity samples",
	  seed: { text: "What method did Hinton propose?", user: "s1", unit: "Chapter 12" },
	  probe: { text: "What method did Vapnik propose?", user: "s2", unit: "Chapter 12" }, expect: "regenerate", catches: 6 },

	{ key: "entity-method4", expectDoc: "h4", label: "Placeholder collapse · LeCun/Breiman", note: "Fourth name pair",
	  seed: { text: "What method did LeCun propose?", user: "s1", unit: "Chapter 12" },
	  probe: { text: "What method did Breiman propose?", user: "s2", unit: "Chapter 12" }, expect: "regenerate", catches: 6 },
];

/** Compose an answer. The template language must match the corpus language —
 *  a mixed-language answer systematically depresses gate ⑥'s support score. */
export function compose(chunks: ReadonlyArray<ComposeChunk>): string {
	if (chunks.length === 0) return "(No material available for this course.)";
	const top = chunks[0];
	const sentences = top.text.split(/(?<=\.)\s+/u).filter(Boolean);
	const lead = sentences[0] ?? top.text;
	const rest = sentences.slice(1).join(" ");
	const also = chunks[1] ? `\n\nWorth reading alongside "${chunks[1].title}".` : "";
	return `In short: ${lead}${rest ? `\n\nIn more detail: ${rest}` : ""}${also}\n\n(Based on "${top.title}" v${top.version}.)`;
}

export function refineSuffix(title: string): string {
	return `\n(Adjusted against "${title}" retrieved for this question.)`;
}
