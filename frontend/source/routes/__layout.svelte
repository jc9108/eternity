<script context="module">
	import * as globals from "frontend/source/globals.js";
	import Footer from "frontend/source/components/footer.svelte";

	import * as svelte from "svelte";
	import firebase from "firebase";

	const globals_r = globals.readonly;
	const globals_w = globals.writable;

	export async function load(obj) {
		let interval_id = null;
		try {
			await new Promise((resolve, reject) => {
				const timeout_id = setTimeout(() => {
					reject("socket connection attempt timed out");
				}, 5000);

				interval_id = setInterval(() => {
					if (globals_r.socket.connected) {
						clearTimeout(timeout_id);
						clearInterval(interval_id);
						resolve();
					}
				}, 100);
			});
			
			return {
				status: 200
			};
		} catch (err) {
			console.error(err);
			clearInterval(interval_id);

			return {
				status: 408
			};
		}
	};
</script>
<script>
	svelte.onMount(() => {
		globals_r.socket.emit("layout mounted");

		globals_r.socket.on("create firebase instances", async (config, auth_token) => {
			try {
				$globals_w.firebase_app = firebase.initializeApp(config);
				$globals_w.firebase_auth = firebase.auth($globals_w.firebase_app);
				await $globals_w.firebase_auth.signInWithCustomToken(auth_token);
				$globals_w.firebase_db = firebase.database($globals_w.firebase_app);
			} catch (err) {
				console.error(err);
			}
		});
	});
	svelte.onDestroy(() => {
		globals_r.socket.off("create firebase instances");

		($globals_w.firebase_app ? $globals_w.firebase_app.delete().catch((err) => console.error(err)) : null);
	});
</script>

<div class="container-fluid text-light">
	<div class="row d-flex justify-content-center">
		<content class="col-12 col-sm-11 col-md-10 col-lg-9 col-xl-8">
			<slot></slot>
			<div class="text-center my-4 pt-2">
				<a href={globals_r.repo} target="_blank"><i id="bottom_gh" class="fab fa-github"></i></a>
			</div>
		</content>
		<Footer/>
	</div>
</div>
