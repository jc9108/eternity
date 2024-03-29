<script context="module">
	import * as globals from "frontend/source/globals.js";
	import * as utils from "frontend/source/utils.js";
	import Navbar from "frontend/source/components/navbar.svelte";

	import * as svelte from "svelte";
	import axios from "axios";
	import underscore from "underscore";

	const globals_r = globals.readonly;
	const globals_w = globals.writable;
</script>
<script>
	export let username;
	
	let [
		last_updated_epoch,
		last_updated_wrappers_update_interval_id,
		last_updated_wrapper_1,
		last_updated_wrapper_2,
		search_input,
		search_btn,
		subreddit_select,
		subreddit_select_btn,
		subreddit_select_dropdown,
		category_btn_group,
		type_btn_group,
		item_list,
		skeleton_list,
		new_data_alert_wrapper
	] = [];

	let active_data = { // entire active_category data
		items: new Map(),
		item_sub_icon_urls: {}
	};
	let active_category = "saved";
	let active_type = "all";
	let active_sub = "all";
	let active_search_str = "";
	let active_item_ids = []; // ids of filtered items (by selected type, subreddit, and search string). only these items will be listed in item_list from active_data
	let items_currently_listed = 0;

	const intersection_observer = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (entry.intersectionRatio > 0) { // observed element is in view
				intersection_observer.unobserve(entry.target);
				list_next_items(25);
			}
		}
	}, {
		root: document,
		rootMargin: "0px",
		threshold: 0
	});

	const debounced_hide_popover = underscore.debounce(() => {
		jQuery("[data-toggle='popover']").popover("hide");
	}, 100, true);

	async function handle_body_click(evt) {
		(evt.target.classList.contains("dropdown-item") || evt.target.parentElement?.classList.contains("dropdown-item") ? subreddit_select_btn.blur() : null);

		if (evt.target.dataset?.url) {
			window.open(evt.target.dataset.url, "_blank");
		} else if (evt.target.parentElement?.dataset?.url && evt.target.tagName != "BUTTON") {
			window.open(evt.target.parentElement.dataset.url, "_blank");
		}

		if (evt.target.classList.contains("copy_link_btn") || evt.target.classList.contains("text_btn") || evt.target.classList.contains("renew_btn")) {
			evt.target.classList.remove("btn-outline-secondary");
			evt.target.classList.add("btn-success");
			setTimeout(() => {
				evt.target.classList.remove("btn-success");
				evt.target.classList.add("btn-outline-secondary");
			}, 500);

			if (evt.target.classList.contains("copy_link_btn")) {
				window.navigator.clipboard.writeText(evt.target.parentElement.dataset.url).catch((err) => console.error(err));
			} else if (evt.target.classList.contains("text_btn")) {
				const post_text_wrapper = evt.target.parentElement.querySelector(".post_text_wrapper");
				if (post_text_wrapper.innerHTML == "") {
					try {
						const post_id = evt.target.parentElement.id;
						
						const response = await axios.get(`https://api.pushshift.io/reddit/search/submission?ids=${post_id}&fields=selftext`);
						const response_data = response.data;

						const post_text = response_data.data[0].selftext;
						post_text_wrapper.innerHTML = (post_text ? underscore.escape(post_text) : "[this is not a text post]");
					} catch (err) {
						console.error(err);
						post_text_wrapper.innerHTML = "[error: pushshift currently down. please try again later]";
					}
				}
				post_text_wrapper.classList.toggle("d-none");
			} else if (evt.target.classList.contains("renew_btn")) {
				const comment_id = evt.target.parentElement.id;

				globals_r.socket.emit("get comment from reddit", comment_id);
				globals_r.socket.once("got comment from reddit", (comment_content) => {
					const content_wrapper = evt.target.parentElement.querySelector(".content_wrapper");
					content_wrapper.innerHTML = underscore.escape(comment_content);

					$globals_w.firebase_db.ref(`${active_category}/items/${comment_id}/content`).set(comment_content).catch((err) => console.error(err));
				});
			}
		}
		
		if (evt.target.classList.contains("delete_btn")) {
			const item_id = evt.target.parentElement.id;

			const all_opened_popovers = document.querySelectorAll(".popover");
			for (const popover of all_opened_popovers) {
				const popover_item_id = popover.children[2].children[0].classList[0];
				
				(popover_item_id != item_id ? jQuery(popover).popover("hide") : null);
			}
		} else if (evt.target.classList.contains("row_1_popover_btn")) {
			const all_row_1_popover_btns = document.querySelectorAll(".row_1_popover_btn");
			for (const btn of all_row_1_popover_btns) {
				if (btn != evt.target) {
					btn.classList.remove("active");
				} else {
					btn.classList.toggle("active");
				}
			}
		} else if (evt.target.classList.contains("delete_item_confirm_btn")) {
			const opened_popover = document.querySelector(".popover");

			let delete_from = null;
			const all_row_1_popover_btns = document.querySelectorAll(".row_1_popover_btn");
			for (const btn of all_row_1_popover_btns) {
				(btn.classList.contains("active") ? delete_from = btn.innerHTML : null);
			}
			if (!delete_from) {
				for (const btn of [...all_row_1_popover_btns]) {
					utils.shake_element(btn);
				}
				return;
			} else {
				jQuery(opened_popover).popover("hide");
			}

			const item_id = evt.target.parentElement.parentElement.classList[0];
			const item_category = active_category;
			const item_type = document.querySelector(`[id="${item_id}"]`).dataset.type;

			if (delete_from == "eternity" || delete_from == "both") {
				const list_item = document.querySelector(`[id="${item_id}"]`);
				list_item.innerHTML = "";
				list_item.removeAttribute("data-url");
				list_item.removeAttribute("data-type");
				list_item.className = "";
				list_item.classList.add("skeleton_item", "rounded", "mb-2");

				try {
					await $globals_w.firebase_db.ref(`${item_category}/items/${item_id}`).remove();
	
					list_item.remove();
					active_item_ids.splice(active_item_ids.indexOf(item_id), 1);
					active_data.items.delete(item_id);
				} catch (err) {
					console.error(err);
				}
			}
			if (delete_from == "Reddit" || delete_from == "both") {
				globals_r.socket.emit("delete item from reddit acc", item_id, item_category, item_type);
			}
		} else if (!evt.target.classList.contains("row_2_popover_btn") && document.querySelector(".popover")?.contains(evt.target)) {
			null;
		} else {
			jQuery("[data-toggle='popover']").popover("hide");
		}

		if (evt.target.parentElement == category_btn_group) {
			const selected_category = await new Promise((resolve, reject) => {
				setTimeout(() => {
					let category = null;
					for (const btn of [...(category_btn_group.children)]) {
						(btn.classList.contains("active") ? category = btn.innerText : null);
					}
					resolve(category);
				}, 100);
			});
			if (selected_category != active_category) {
				active_category = selected_category;
				show_skeleton_loading();
				try {
					await get_parse_set_active_data();
				} catch (err) {
					console.error(err);
				}
				refresh_item_list();
				hide_skeleton_loading();
				update_search_placeholder();
				fill_subreddit_select();
			}
		} else if (evt.target.parentElement == type_btn_group) {
			const selected_type = await new Promise((resolve, reject) => {
				setTimeout(() => {
					let type = null;
					for (const btn of [...(type_btn_group.children)]) {
						(btn.classList.contains("active") ? type = btn.innerText : null);
					}
					resolve(type);
				}, 100);
			});
			if (selected_type != active_type) {
				active_type = selected_type;
				refresh_item_list();
				update_search_placeholder();
				fill_subreddit_select();
			}
		}

		if (evt.target.id == "refresh_btn") {
			new_data_alert_wrapper.classList.add("d-none");
			show_skeleton_loading();
			try {
				await get_parse_set_active_data();
			} catch (err) {
				console.error(err);
			}
			refresh_item_list();
			hide_skeleton_loading();
			update_search_placeholder();
			fill_subreddit_select();
		}
	}

	function handle_body_keydown(evt) {
		if (evt.key == "Escape") {
			jQuery("[data-toggle='popover']").popover("hide");
		}
		
		setTimeout(() => {
			const no_results = document.querySelector(".no-results");
			(no_results && !no_results.classList.contains("d-none") ? no_results.classList.add("d-none") : null);

			(subreddit_select_dropdown && typeof subreddit_select_dropdown != "number" && !subreddit_select_dropdown.classList.contains("show") ? subreddit_select_btn.blur() : null);
		}, 100);
	}

	async function get_parse_set_active_data() {
		active_data.items.clear();
		active_data.item_sub_icon_urls = {};

		const snapshot = await $globals_w.firebase_db.ref(active_category).get();
		const data = snapshot.val();
		if (data) {
			if (data.items) {
				const sorted_items_entries = Object.entries(data.items).sort((a, b) => b[1].created_epoch - a[1].created_epoch); // sort by created_epoch, descending
				for (const entry of sorted_items_entries) {
					const item_key = entry[0];
					const item_value = entry[1];
			
					active_data.items.set(item_key, item_value);
				}
			}

			if (data.item_sub_icon_urls) {
				const icon_urls_entries = Object.entries(data.item_sub_icon_urls);
				for (const entry of icon_urls_entries) {
					const icon_url_key = entry[0];
					const icon_url_value = entry[1];

					active_data.item_sub_icon_urls[icon_url_key.replace("|", "/").replace(",", ".")] = icon_url_value;
				}
			}	
		}
	}

	function show_skeleton_loading() {
		item_list.scrollTop = 0;
		item_list.classList.add("d-none");
		skeleton_list.classList.remove("d-none");
	}

	function hide_skeleton_loading() {
		skeleton_list.classList.add("d-none");
		item_list.classList.remove("d-none");
		item_list.scrollTop = 0;
	}

	function set_active_item_ids() { // filter ➔ set
		// filter by selected type
		switch (active_type) {
			case "all":
				active_item_ids = [...(active_data.items.keys())];
				break;
			case "posts":
			case "comments":
				active_item_ids = [];
				for (const entry of active_data.items) {
					const item_key = entry[0];
					const item_value = entry[1];

					(item_value.type == active_type.slice(0, -1) ? active_item_ids.push(item_key) : null);
				}
				break;
			default:
				break;
		}

		// filter by selected subreddit
		if (active_sub != "all") {
			const filtered_items = new Map();
			for (const item_id of active_item_ids) {
				filtered_items.set(item_id, active_data.items.get(item_id));
			}
		
			active_item_ids = [];
			for (const entry of filtered_items) {
				const item_key = entry[0];
				const item_value = entry[1];

				(item_value.sub == active_sub ? active_item_ids.push(item_key) : null);
			}
		}

		// filter by search string
		if (active_search_str != "") {
			const space_delimited_search_input = active_search_str.split(" ").map((term, idx, arr) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); // escape regex special chars: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions

			const filtered_items = new Map();
			for (const item_id of active_item_ids) {
				filtered_items.set(item_id, active_data.items.get(item_id));
			}
		
			active_item_ids = [];
			for (const entry of filtered_items) {
				const item_key = entry[0];
				const item_value = entry[1];

				let matches = 0;
				for (const term of space_delimited_search_input) {
					const re = new RegExp(term, "i");
					(re.test(item_value.sub) || re.test(item_value.author) || re.test(item_value.content) ? matches++ : null);
				}
				(matches == space_delimited_search_input.length ? active_item_ids.push(item_key) : null);
			}
		}
	}

	function list_next_items(count) {
		if (active_type == "comments" && (active_category == "upvoted" || active_category == "downvoted" || active_category == "hidden")) {
			item_list.innerHTML = `<div class="list-group-item text-light lead">${active_category} comment data not provided by Reddit api</div>`;
			return;
		}

		const max_items = active_item_ids.length;
		if (max_items == 0) {		
			item_list.innerHTML = '<div class="list-group-item text-light lead">no results</div>';
			return;
		}
		
		const x = items_currently_listed + count;
		while (items_currently_listed < x && items_currently_listed < max_items) {
			const item_id = active_item_ids[items_currently_listed];
			const item = active_data.items.get(item_id);

			item_list.insertAdjacentHTML("beforeend", `
				<div id="${item_id}" class="list-group-item list-group-item-action text-left text-light p-1" data-url="${item.url}" data-type="${item.type}">
					<a href="https://www.reddit.com/${item.sub}" target="_blank"><img src="${active_data.item_sub_icon_urls[item.sub]}" class="rounded-circle${(active_data.item_sub_icon_urls[item.sub] == "#" ? "" : " border border-light")}"/></a><small><a href="https://www.reddit.com/${item.sub}" target="_blank"><b class="ml-2">${item.sub}</b></a> &bull; <a href="https://www.reddit.com/${item.author}" target="_blank">${item.author}</a> &bull; <i data-url="${item.url}" data-toggle="tooltip" data-placement="top" title="${utils.epoch_to_formatted_datetime(item.created_epoch)}">${utils.time_since(item.created_epoch)}</i></small>
					<p class="lead line_height_1 m-0" data-url="${item.url}"><${(item.type == "post" ? "b" : "small")} class="content_wrapper noto_sans">${underscore.escape(item.content)}</${(item.type == "post" ? "b" : "small")}></p>
					<button type="button" class="delete_btn btn btn-sm btn-outline-secondary shadow-none border-0 py-0" data-toggle="popover" data-placement="right" data-title="delete item from" data-content='<div class="${item_id}"><div><span class="row_1_popover_btn btn btn-sm btn-primary float-left px-0">eternity</span><span class="row_1_popover_btn btn btn-sm btn-primary float-center px-0">Reddit</span><span class="row_1_popover_btn btn btn-sm btn-primary float-right px-0">both</span></div><div><span class="row_2_popover_btn btn btn-sm btn-secondary float-left mt-2">cancel</span><span class="row_2_popover_btn delete_item_confirm_btn btn btn-sm btn-danger float-right mt-2">confirm</span></div><div class="clearfix"></div></div>' data-html="true">delete</button> <button type="button" class="copy_link_btn btn btn-sm btn-outline-secondary shadow-none border-0 py-0">copy link</button> <button type="button" class="${(item.type == "post" ? "text" : "renew")}_btn btn btn-sm btn-outline-secondary shadow-none border-0 py-0">${(item.type == "post" ? "text" : "renew")}</button>
					${(item.type == "post" ? '<p class="post_text_wrapper noto_sans line_height_1 d-none m-0"></p>' : "")}
				</div>
			`);

			(++items_currently_listed == x-Math.floor(count/2)-1 ? intersection_observer.observe(document.querySelector(`[id="${item_id}"]`)) : null);

			jQuery('[data-toggle="tooltip"]').tooltip("enable");
			jQuery('[data-toggle="popover"]').popover("enable");
		}
	}

	function refresh_item_list() {
		intersection_observer.disconnect(); // stops observing all currently observed elements. (does NOT stop the intersection observer. i.e., it can still observe new elements)
		item_list.innerHTML = "";
		item_list.scrollTop = 0;
		items_currently_listed = 0;

		set_active_item_ids();
		list_next_items(25);
	}

	function update_search_placeholder() {
		const item_count = active_item_ids.length;
		search_input.placeholder = `search ${item_count} item${(item_count == 1 ? "" : "s")}`;
	}

	function fill_subreddit_select() {
		subreddit_select.innerHTML = "<option>all</option>";

		let subs = new Set();
		if (active_type == "all") {
			for (const entry of active_data.items) {
				const item_key = entry[0];
				const item_value = entry[1];

				subs.add(item_value.sub);
			}
		} else {
			for (const entry of active_data.items) {
				const item_key = entry[0];
				const item_value = entry[1];

				(item_value.type == active_type.slice(0, -1) ? subs.add(item_value.sub) : null);
			}
		}

		subs = [...subs];
		subs.sort((a, b) => a.localeCompare(b, "en"));

		for (const sub of subs) {
			subreddit_select.insertAdjacentHTML("beforeend", `
				<option>${sub}</option>
			`);
		}
		jQuery(subreddit_select).selectpicker("refresh");
		jQuery(subreddit_select).selectpicker("render");
	}

	svelte.onMount(async () => {
		globals_r.socket.emit("page", "access");
		
		globals_r.socket.on("store last updated epoch", (epoch) => {
			last_updated_epoch = epoch;
		});

		globals_r.socket.on("show refresh alert", (categories_w_new_data) => {
			for (const category of categories_w_new_data) {
				if (category == active_category) {
					new_data_alert_wrapper.classList.remove("d-none");
					utils.show_alert(new_data_alert_wrapper, '<span class="ml-1">new data available!</span><button id="refresh_btn" class="btn btn-sm btn-primary ml-2">refresh</button>', "primary");
					break;
				}
			}
		});

		last_updated_wrappers_update_interval_id = setInterval(() => {
			if (last_updated_epoch) {
				last_updated_wrapper_1.innerHTML = utils.time_since(last_updated_epoch);
				last_updated_wrapper_2.innerHTML = utils.epoch_to_formatted_datetime(last_updated_epoch);
			}
		}, 1000);

		try {
			await new Promise((resolve, reject) => {
				const interval_id = setInterval(() => {
					if ($globals_w.firebase_app && $globals_w.firebase_auth && $globals_w.firebase_db) {
						clearInterval(interval_id);
						resolve();
					}
				}, 100);
			});

			await get_parse_set_active_data();
			refresh_item_list();
			hide_skeleton_loading();
			update_search_placeholder();
			fill_subreddit_select();
		} catch (err) {
			console.error(err);
		}

		jQuery(subreddit_select).selectpicker();
		subreddit_select_btn = document.querySelector(".bs-placeholder");
		subreddit_select_dropdown = document.querySelector(".bootstrap-select");

		jQuery(subreddit_select).on("changed.bs.select", (evt, clicked_idx, is_selected, previous_value) => { // https://developer.snapappointments.com/bootstrap-select/options/#events
			active_sub = evt.target.value;
			refresh_item_list();
			update_search_placeholder();
		});

		last_updated_wrapper_1.addEventListener("click", (evt) => {
			last_updated_wrapper_2.classList.toggle("d-none");
		});

		last_updated_wrapper_2.addEventListener("click", (evt) => {
			evt.target.classList.toggle("d-none");
		});

		subreddit_select_btn.addEventListener("click", (evt) => {
			(!subreddit_select_dropdown.classList.contains("show") ? subreddit_select_btn.blur() : null);
		});

		search_input.addEventListener("keydown", (evt) => {
			if (evt.target.value.trim() == "") {
				return;
			}

			switch (evt.key) {
				case "Enter":
					active_search_str = evt.target.value.trim();
					refresh_item_list();
					break;
				case "Escape":
					evt.target.value = "";
					active_search_str = "";
					refresh_item_list();
					break;
				case "Backspace":
				case "Delete":
					setTimeout(() => {
						if (active_search_str && evt.target.value.trim() == "") {
							active_search_str = "";
							refresh_item_list();
						}
					}, 100);
					break;
				default:
					break;
			}
		});

		search_btn.addEventListener("click", (evt) => {
			search_input.dispatchEvent(new KeyboardEvent("keydown", {
				key: "Enter"
			}));
		});

		item_list.addEventListener("scroll", (evt) => {
			debounced_hide_popover();
		});
	});
	svelte.onDestroy(() => {
		globals_r.socket.off("store last updated epoch");
		globals_r.socket.off("show refresh alert");

		clearInterval(last_updated_wrappers_update_interval_id);
	});
</script>

<svelte:body on:click={handle_body_click} on:keydown={handle_body_keydown}/>
<Navbar username={username} show_data_anchors={true}/>
<div class="text-center mt-3">
	<h1 class="display-4">{globals_r.app_name}</h1>
	<span>last updated: <b bind:this={last_updated_wrapper_1} id="last_updated_wrapper_1">?</b> ago</span>
	<br/>
	<small bind:this={last_updated_wrapper_2} class="d-none">?</small>
	<div class="d-flex justify-content-center">
		<div bind:this={new_data_alert_wrapper} class="px-1 d-none"></div>
	</div>
	<div id="access_container" class="card card-body bg-dark mt-3 pb-3">
		<form>
			<div class="form-row d-flex justify-content-center">
				<div bind:this={category_btn_group} class="btn-group btn-group-toggle flex-wrap" data-toggle="buttons">
					<label class="btn btn-secondary shadow-none active"><input type="radio" name="options"/>saved</label>
					<label class="btn btn-secondary shadow-none"><input type="radio" name="options"/>created</label>
					<label class="btn btn-secondary shadow-none"><input type="radio" name="options"/>upvoted</label>
					<label class="btn btn-secondary shadow-none"><input type="radio" name="options"/>downvoted</label>
					<label class="btn btn-secondary shadow-none"><input type="radio" name="options"/>hidden</label>
				</div>
			</div>
			<div class="form-row d-flex justify-content-center mt-2">
				<div bind:this={type_btn_group} class="btn-group btn-group-toggle flex-wrap" data-toggle="buttons">
					<label class="btn btn-secondary shadow-none"><input type="radio" name="options"/>posts</label>
					<label class="btn btn-secondary shadow-none"><input type="radio" name="options"/>comments</label>
					<label class="btn btn-secondary shadow-none active"><input type="radio" name="options"/>all</label>
				</div>
			</div>
			<div class="form-row mt-2">
				<div class="form-group col-12 col-sm-8 mb-0">
					<div class="d-flex input-group">
						<input bind:this={search_input} type="text" class="form-control bg-light" placeholder="search ? items"/>
						<div class="input-group-append"><button bind:this={search_btn} type="button" class="btn btn-light shadow-none"><i class="fa fa-search"></i></button></div>
					</div>
				</div>
				<div class="form-group col-12 col-sm-4 mb-0">
					<select bind:this={subreddit_select} class="selectpicker form-control" data-width="false" data-size="10" data-live-search="true" title="in subreddit: all">
						<option>all</option>
					</select>
				</div>
			</div>
		</form>
	</div>
	<div class="card card-body bg-dark border-top-0 mt-n2 pt-0 pb-2 pr-2">
		<div bind:this={item_list} class="list-group list-group-flush border-0 d-none" id="item_list"></div>
		<div bind:this={skeleton_list} class="list-group" id="skeleton_list">
			{#each {length: 7} as _, idx}
				<div class="skeleton_item rounded mb-2"></div>
			{/each}
		</div>
	</div>
</div>
