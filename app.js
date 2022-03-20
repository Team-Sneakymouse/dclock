const express = require("express");
const app = express();

app.use('/assets', express.static('assets'));

app.set('view engine', 'ejs');
app.set('views', __dirname);

app.get('/', function (req, res) {
	const doom = new Date(1735189200000);
	var now = new Date();
	var diffMs = parseInt((doom - now) / 1000);
	var string = diffMs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	res.render('./index', { seconds: string });
})

app.listen(80, () => console.log("Server started on port 80"));
