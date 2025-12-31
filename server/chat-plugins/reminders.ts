/**
 * Reminders plugin
 * Sets timed reminders for users.
 */

import { FS } from '../../lib';

export interface Reminder {
	message: string;
	time: number;
	id: number;
}

const reminders: Record<string, Reminder[]> = {};
const reminderTimers: Record<string, NodeJS.Timeout> = {};

function saveReminders() {
	FS('config/chat-plugins/reminders.json').writeUpdate(() => JSON.stringify(reminders));
}

function loadReminders() {
	try {
		const data = FS('config/chat-plugins/reminders.json').readIfExistsSync();
		if (data) {
			const parsed = JSON.parse(data);
			for (const userid in parsed) {
				reminders[userid] = parsed[userid];
				for (const reminder of reminders[userid]) {
					scheduleReminder(userid as ID, reminder);
				}
			}
		}
	} catch {}
}

function scheduleReminder(userid: ID, reminder: Reminder) {
	const waitTime = reminder.time - Date.now();
	if (waitTime <= 0) {
		triggerReminder(userid, reminder);
	} else {
		const timerId = `${userid}-${reminder.id}`;
		if (reminderTimers[timerId]) clearTimeout(reminderTimers[timerId]);
		reminderTimers[timerId] = setTimeout(() => {
			triggerReminder(userid, reminder);
		}, waitTime);
	}
}

function triggerReminder(userid: ID, reminder: Reminder) {
	const user = Users.get(userid);
	if (user?.connected) {
		user.send(`|pm|~|${user.getIdentity()}|Reminder: ${reminder.message}`);
	}
	const userReminders = reminders[userid];
	if (userReminders) {
		const index = userReminders.findIndex(r => r.id === reminder.id);
		if (index !== -1) {
			userReminders.splice(index, 1);
			if (userReminders.length === 0) delete reminders[userid];
			saveReminders();
		}
	}
	delete reminderTimers[`${userid}-${reminder.id}`];
}

function toTimedDurationString(duration: number) {
	const seconds = Math.floor(duration / 1000) % 60;
	const minutes = Math.floor(duration / (60 * 1000)) % 60;
	const hours = Math.floor(duration / (60 * 60 * 1000)) % 24;
	const days = Math.floor(duration / (24 * 60 * 60 * 1000));

	let res = '';
	if (days) res += `${days}d`;
	if (hours) res += `${hours}h`;
	if (minutes) res += `${minutes}m`;
	if (seconds) res += `${seconds}s`;
	return res || '0s';
}

function parseDuration(timeStr: string): number | null {
	timeStr = timeStr.trim();
	if (!timeStr) return null;

	const dateMatch = /^(\d{1,2})-(\d{1,2})-(\d{4}) (\d{1,2}):(\d{1,2})$/.exec(timeStr);
	if (dateMatch) {
		const [, month, day, year, hour, minute] = dateMatch;
		const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute));
		const duration = date.getTime() - Date.now();
		return isNaN(duration) ? null : duration;
	}

	const timeMatch = /^(\d+d)?\s*(\d+h)?\s*(\d+m)?\s*(\d+s)?$/i.exec(timeStr);
	if (timeMatch && (timeMatch[1] || timeMatch[2] || timeMatch[3] || timeMatch[4])) {
		let duration = 0;
		if (timeMatch[1]) duration += parseInt(timeMatch[1]) * 24 * 60 * 60 * 1000;
		if (timeMatch[2]) duration += parseInt(timeMatch[2]) * 60 * 60 * 1000;
		if (timeMatch[3]) duration += parseInt(timeMatch[3]) * 60 * 1000;
		if (timeMatch[4]) duration += parseInt(timeMatch[4]) * 1000;
		return duration;
	}

	return null;
}

export const commands: Chat.ChatCommands = {
	remindme: {
		cancel(target, room, user) {
			const id = parseInt(target);
			if (isNaN(id)) return this.errorReply("Invalid reminder ID.");
			const userReminders = reminders[user.id];
			if (!userReminders) return this.errorReply("You have no pending reminders.");
			const index = userReminders.findIndex(r => r.id === id);
			if (index === -1) return this.errorReply("Reminder ID not found.");

			const [reminder] = userReminders.splice(index, 1);
			if (userReminders.length === 0) delete reminders[user.id];
			const timerId = `${user.id}-${reminder.id}`;
			if (reminderTimers[timerId]) {
				clearTimeout(reminderTimers[timerId]);
				delete reminderTimers[timerId];
			}
			saveReminders();
			this.sendReply(`Reminder "${reminder.message}" cancelled.`);
		},
		view(target, room, user) {
			const userReminders = reminders[user.id];
			if (!userReminders || userReminders.length === 0) {
				return this.sendReply("no pending reminders");
			}
			this.sendReply("REMAININGTIME");
			for (const r of userReminders) {
				this.sendReply(`TIME is ${toTimedDurationString(r.time - Date.now())} - ${r.message} (ID: ${r.id})`);
			}
		},
		clearall(target, room, user) {
			const userReminders = reminders[user.id];
			if (!userReminders) return this.errorReply("You have no pending reminders.");
			for (const reminder of userReminders) {
				const timerId = `${user.id}-${reminder.id}`;
				if (reminderTimers[timerId]) {
					clearTimeout(reminderTimers[timerId]);
					delete reminderTimers[timerId];
				}
			}
			delete reminders[user.id];
			saveReminders();
			this.sendReply("All your reminders have been cleared.");
		},
		''(target, room, user) {
			const [timePart, ...messageParts] = target.split(',');
			const message = messageParts.join(',').trim();
			if (!timePart || !message) {
				return this.parse('/help remindme');
			}

			const duration = parseDuration(timePart);
			if (duration === null) return this.errorReply("Invalid time format.");
			if (duration < 60 * 1000) return this.errorReply("The duration must be at least one minute.");
			if (duration > 365 * 24 * 60 * 60 * 1000) {
				return this.errorReply("The duration must be no more than one year.");
			}

			if (message.length > 200) return this.errorReply("The reminder message is limited to 200 characters.");

			if (!reminders[user.id]) reminders[user.id] = [];
			if (reminders[user.id].length >= 5) return this.errorReply("You can only have up to 5 reminders.");

			const id = (reminders[user.id].length > 0 ? Math.max(...reminders[user.id].map(r => r.id)) + 1 : 1);
			const reminder: Reminder = {
				message,
				time: Date.now() + duration,
				id,
			};
			reminders[user.id].push(reminder);
			scheduleReminder(user.id, reminder);
			saveReminders();
			this.sendReply(`Reminder set for ${toTimedDurationString(duration)} from now.`);
		},
	},
	remindmehelp: [
		"/remindme [time], [message] - Sets a reminder for [time] from now. [time] can be like 5m, 1h30m, or MM-DD-YYYY HH:MM.",
		"/remindme cancel [id] - Cancels a reminder.",
		"/remindme view - Views your pending reminders.",
		"/remindme clearall - Clears all your reminders.",
	],
};

export const handlers: Chat.Handlers = {
	onRename(user, oldID, newID) {
		if (reminders[oldID]) {
			if (!reminders[newID]) reminders[newID] = [];
			const userReminders = reminders[newID];
			while (reminders[oldID].length > 0 && userReminders.length < 5) {
				const reminder = reminders[oldID].shift()!;
				const oldTimerId = `${oldID}-${reminder.id}`;
				if (reminderTimers[oldTimerId]) {
					clearTimeout(reminderTimers[oldTimerId]);
					delete reminderTimers[oldTimerId];
				}
				reminder.id = (userReminders.length > 0 ? Math.max(...userReminders.map(r => r.id)) + 1 : 1);
				userReminders.push(reminder);
				scheduleReminder(newID, reminder);
			}
			if (reminders[oldID].length === 0) delete reminders[oldID];
			saveReminders();
		}
	},
};

loadReminders();

export function destroy() {
	for (const id in reminderTimers) {
		clearTimeout(reminderTimers[id]);
	}
}
