import express from "express";
import PocketBase from "pocketbase";

const pocketbase = new PocketBase("https://db.rawb.tv");
const app = express();

app.use((req, res, next) => {
	res.setHeader(
		'Content-Security-Policy',
		"default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;"
	);

	next();
});

app.use('/assets', express.static('assets'));
app.use("/pb", express.static("node_modules/pocketbase/dist"));

app.set('view engine', 'ejs');
app.set('views', ".");

app.get('/', async function (req, res) {
	try {
		// Fetch on each request so embeds cannot retain a missed realtime update.
		const doc = await pocketbase.collection("settings").getOne("9195r6z2omp337a", { requestKey: null });
		const doom = new Date(Number(doc.value) * 1000);
		if (!Number.isFinite(doom.getTime())) throw new Error("Invalid countdown deadline");
		var now = new Date();
		var diffMs = parseInt((doom - now) / 1000);
		var string = diffMs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		res.render('./index', { seconds: string });
	} catch (error) {
		console.error("Failed to load countdown:", error);
		res.status(503).send("Countdown temporarily unavailable");
	}
})

app.listen(80, () => console.log("Server started on port 80"));
