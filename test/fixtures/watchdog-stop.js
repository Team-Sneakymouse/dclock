// Run by listener.test.js as its own process: starts a listener whose watchdog ping never comes back, stops it while
// the watchdog waits (10 s), and must then exit at once because nothing keeps the process alive.
import { createHub } from "../../lib/hub.js";
import { createListener } from "../../lib/listener.js";

const quiet = { log() {}, error() {} };
const pinged = Promise.withResolvers();
const connect = () => ({
	listen(_channel, _onNotify, onlisten) {
		queueMicrotask(() => onlisten?.());
		return Promise.resolve();
	},
	close: () => Promise.resolve(),
});
const db = () => Promise.resolve([{ amount: 1, version: "1" }]);
db.notify = () => {
	pinged.resolve();
	return Promise.resolve(); // never echoed
};
const listener = createListener({
	url: "postgres://test",
	db,
	hub: createHub({ log: quiet }),
	channel: "sneakydclock",
	connect,
	log: quiet,
	watchdogMs: 10,
	watchdogWaitMs: 10_000,
});
listener.start();
await pinged.promise;
await Bun.sleep(20); // the check is now waiting for its ping
await listener.stop();
console.log("stopped");
