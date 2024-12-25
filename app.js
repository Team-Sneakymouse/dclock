import express from "express";
import PocketBase from "pocketbase";
import { EventSource } from 'eventsource'
global.EventSource = EventSource;

const pocketbase = new PocketBase("https://db.rawb.tv");
let value = -1;
pocketbase.collection("lom2_magicspells").getOne("2joauwmh4zsos5p").then((doc) => {
	value = Number(doc.value);
	console.log("value is " + value);
});
pocketbase.collection("lom2_magicspells").subscribe("2joauwmh4zsos5p", (e) => {
	value = Number(e.record.value);
});

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

app.get('/', function (req, res) {
	const doom = new Date(1735189200000 + value * 1000);
	var now = new Date();
	var diffMs = parseInt((doom - now) / 1000);
	var string = diffMs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	res.render('./index', { seconds: string });
})

app.listen(80, () => console.log("Server started on port 80"));
