// The fixed texts that the tools of Petra send to the owner, in English and in Arabic (requirement N9).
// The code selects the language from the message of the owner, as it does for the answer of the model.
import type { Language } from "./language.js";

const STATUS_AR: Record<string, string> = {
	starting: "تبدأ",
	running: "تعمل",
	"waiting for the owner": "تنتظر ردك",
	done: "انتهت",
	failed: "فشلت",
	cancelled: "أُلغيت",
};

export interface ToolTexts {
	whichTaskForMessage: string;
	notClear: string;
	whichBot: string;
	gaveMessage(taskId: string): string;
	started(taskId: string): string;
	noCredits: string;
	ended(taskId: string): string;
	noOpenTask: string;
	whichTaskToStop: string;
	status(taskId: string, status: string, activity?: { attemptNo: number; turnNo: number; lastAt: string }): string;
	rememberForm: string;
	promoteForm: string;
}

const EN: ToolTexts = {
	whichTaskForMessage: "Which task is your message for?",
	notClear: "Your request is not clear to me. What must the task do?",
	whichBot: "Which bot must do this task?",
	gaveMessage: (taskId) => `I gave your message to the task ${taskId}.`,
	started: (taskId) => `I started the task ${taskId}.`,
	noCredits: "Your credits are not sufficient for this task.",
	ended: (taskId) => `The task ${taskId} ended.`,
	noOpenTask: "You have no open task.",
	whichTaskToStop: "Which task do I stop?",
	status: (taskId, status, activity) => {
		const detail = activity
			? ` It is in attempt ${activity.attemptNo}, turn ${activity.turnNo}. The last row is from ${activity.lastAt}.`
			: "";
		return `The task ${taskId} is ${status}.${detail}`;
	},
	rememberForm: "Write the fact as: remember on <page>: <text>.",
	promoteForm: "Write the promote as: promote fact <id>.",
};

const AR: ToolTexts = {
	whichTaskForMessage: "لأي مهمة رسالتك؟",
	notClear: "طلبك غير واضح لي. ماذا يجب أن تفعل المهمة؟",
	whichBot: "أي بوت يجب أن يقوم بهذه المهمة؟",
	gaveMessage: (taskId) => `أعطيت رسالتك للمهمة ${taskId}.`,
	started: (taskId) => `بدأت المهمة ${taskId}.`,
	noCredits: "رصيدك غير كافٍ لهذه المهمة.",
	ended: (taskId) => `انتهت المهمة ${taskId}.`,
	noOpenTask: "ليس لديك مهمة مفتوحة.",
	whichTaskToStop: "أي مهمة أوقف؟",
	status: (taskId, status, activity) => {
		const detail = activity
			? ` هي في المحاولة ${activity.attemptNo}، الدور ${activity.turnNo}. آخر سجل من ${activity.lastAt}.`
			: "";
		return `المهمة ${taskId} ${STATUS_AR[status] ?? status}.${detail}`;
	},
	rememberForm: "اكتب المعلومة هكذا: remember on <page>: <text>.",
	promoteForm: "اكتب الترقية هكذا: promote fact <id>.",
};

export const toolTexts = (language: Language): ToolTexts => (language === "ar" ? AR : EN);
