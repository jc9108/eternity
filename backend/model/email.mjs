const backend = process.cwd();
const run_config = (backend.toLowerCase().startsWith("/mnt/c/") ? "dev" : "prod");

const secrets = (run_config == "dev" ? (await import(`${backend}/.secrets.mjs`)).dev : (await import(`${backend}/.secrets.mjs`)).prod);
const cryptr = await import(`${backend}/model/cryptr.mjs`);

import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
	service: "gmail",
	auth: {
		type: "OAuth2",
		clientId: secrets.nodemailer_gcp_client_id,
		clientSecret: secrets.nodemailer_gcp_client_secret,
		user: secrets.nodemailer_gmail_addr,
		refreshToken: secrets.nodemailer_gmail_refresh_token
	}
});

function send(user, subject, msg) {
	const mail_options = {
		from: '"eternity" <eternity@portals.sh>',
		to: cryptr.decrypt(user.email_encrypted),
		subject: subject,
		html: `
			<span>u/${user.username},</span><br/>
			<br/>
			<b>${msg}</b><br/>
			<br/>
			<br/>
			<span>—</span><br/>
			<a href=${(run_config == "dev" ? "http://localhost:" + (secrets.port-1) : "https://eternity.portals.sh")} target="_blank">eternity</a>
		`
	};

	transporter.sendMail(mail_options, (err, info) => (err ? console.error(err) : console.log(info)));
}

export {
	send
};
