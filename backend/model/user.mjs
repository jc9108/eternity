const backend = process.cwd();

const sql = await import(`${backend}/model/sql.mjs`);
const firebase = await import(`${backend}/model/firebase.mjs`);
const reddit = await import(`${backend}/model/reddit.mjs`);
const cryptr = await import(`${backend}/model/cryptr.mjs`);
const email = await import(`${backend}/model/email.mjs`);
const logger = await import(`${backend}/model/logger.mjs`);
const utils = await import(`${backend}/model/utils.mjs`);

let update_all_completed = null;

const usernames_to_socket_ids = {};
const socket_ids_to_usernames = {};

class User {
	constructor(username, refresh_token, dummy=false) {
		this.username = username;

		if (dummy) {
			null;
		} else {
			this.reddit_api_refresh_token_encrypted = cryptr.encrypt(refresh_token);
			this.category_sync_info = {
				saved: {
					latest_fn_mixed: null,
					latest_new_data_epoch: null
				},
				created: {
					latest_fn_posts: null,
					latest_fn_comments: null,
					latest_new_data_epoch: null
				},
				upvoted: {
					latest_fn_posts: null,
					latest_new_data_epoch: null
				},
				downvoted: {
					latest_fn_posts: null,
					latest_new_data_epoch: null
				},
				hidden: {
					latest_fn_posts: null,
					latest_new_data_epoch: null
				},
				awarded: {
					latest_fn_mixed: null,
					latest_new_data_epoch: null
				}
			};
			this.last_updated_epoch = null;
			this.last_active_epoch = utils.now_epoch();
			this.email_encrypted = null;
			this.email_notif = {
				last_inactive_notif_epoch: null,
				last_update_failed_notif_epoch: null
			};
			this.firebase_service_acc_key_encrypted = null;
			this.firebase_web_app_config_encrypted = null;
		}
	}
	async save() {
		let user_for_comparison = null;
		try {
			user_for_comparison = await get(this.username, true);
		} catch (err) {
			if (err != `Error: user (${this.username}) dne`) {
				console.error(err);
				logger.error(err);
				return;
			}
		}
		
		if (!user_for_comparison || !user_for_comparison.last_updated_epoch) {
			console.log(`new user (${this.username})`);

			await sql.save_user(this.username, this.reddit_api_refresh_token_encrypted, this.category_sync_info, this.last_active_epoch, this.email_notif);
		} else {
			console.log(`returning user (${this.username})`);

			await sql.update_user(this.username, {
				reddit_api_refresh_token_encrypted: this.reddit_api_refresh_token_encrypted
			});
		}

		console.log(`saved user (${this.username})`);
	}
	async get_listing(options, category, type) {
		let listing = null;
		switch (category) {
			case "saved": // posts, comments
				listing = await this.me.getSavedContent(options);
				break;
			case "created": // posts, comments
				switch (type) {
					case "posts":
						listing = await this.me.getSubmissions(options);
						break;
					case "comments":
						listing = await this.me.getComments(options);
						break;
					default:
						break;
				}
				break;
			case "upvoted": // posts
				listing = await this.me.getUpvotedContent(options);
				break;
			case "downvoted": // posts
				listing = await this.me.getDownvotedContent(options);
				break;
			case "hidden": // posts
				listing = await this.me.getHiddenContent(options);
				break;
			case "awarded": // posts, comments
				listing = await this.me._getListing({
					uri: `u/${this.username}/gilded/given`,
					qs: options
				});
				break;
			default:
				break;
		}
		return listing;
	}
	parse_listing(listing, category, type, from_mixed=false, from_import=false) {
		if (type == "mixed") {
			(!from_import ? this.category_sync_info[category].latest_fn_mixed = listing[0].name : null);

			const posts = [];
			const comments = [];

			for (const item of listing) {
				switch (item.constructor.name) {
					case "Submission":
						posts.push(item);
						break;
					case "Comment":
						comments.push(item);
						break;
					default:
						break;
				}
			}
	
			this.parse_listing(posts, category, "posts", true);
			this.parse_listing(comments, category, "comments", true);
		} else {
			(!from_mixed && !from_import ? this.category_sync_info[category][`latest_fn_${type}`] = listing[0].name : null);

			for (const item of listing) {
				this.new_data[category].items[item.id] = {
					type: (type == "posts" ? "post" : "comment"),
					content: (type == "posts" ? item.title : item.body),
					author: `u/${item.author.name}`,
					sub: item.subreddit_name_prefixed,
					url: `https://www.reddit.com${utils.strip_trailing_slash(item.permalink)}`,
					created_epoch: item.created_utc
				};

				this.sub_icon_urls_to_get[category].add(item.subreddit_name_prefixed);
			}
		}
	}
	async replace_latest_fn(category, type) {
		const options = {
			limit: 1
		};
		const listing = await this.get_listing(options, category, type);
		
		const latest_fn = (listing.length != 0 ? listing[0].name : null);
		this.category_sync_info[category][`latest_fn_${type}`] = latest_fn;
	}
	async sync_category(category, type) {
		let options = {
			limit: 5,
			before: this.category_sync_info[category][`latest_fn_${type}`] // "before" is actually chronologically after. https://www.reddit.com/dev/api/#listings
		};
		const listing = await this.get_listing(options, category, type);

		if (listing.isFinished) {
			if (listing.length == 0) { // either listing actually has no items, or user deleted the latest_fn item from the listing on reddit (like, deleted it from reddit ON reddit, not deleted it from reddit on eternity)
				await this.replace_latest_fn(category, type);
			} else {
				this.parse_listing(listing, category, type);
				this.category_sync_info[category].latest_new_data_epoch = utils.now_epoch();
			}
		} else {
			const extended_listing = await listing.fetchAll({
				append: true
			});
			this.parse_listing(extended_listing, category, type);
			this.category_sync_info[category].latest_new_data_epoch = utils.now_epoch();
		}
	}
	async import_category(category, type) {
		const data = await firebase.get_fns_to_import(this.firebase_db, category);
		if (data) {
			const fns = Object.keys(data);

			console.log(`importing (${fns.length}) (${category}) items`);

			const promises = [];

			const required_requests = Math.ceil(fns.length / 100);
			for (let i = 0; i < required_requests; i++) {
				promises.push(this.requester.getContentByIds(fns.slice(i*100, i*100 + 100))); // getContentByIds only takes max of 100 fns at once
			}
	
			const listings = await Promise.all(promises);
			for (const listing of listings) {
				this.parse_listing(listing, category, type, false, true);
			}

			this.category_sync_info[category].latest_new_data_epoch = utils.now_epoch();
	
			this.imported_fns_to_delete[category] = fns;
		}
	}
	async request_item_icon_urls(type, subs, category) {
		const promises = [];

		let required_requests = null;
		const ratelimit_remaining = this.requester.ratelimitRemaining;
		let i = 0;

		switch (type) {
			case "r/":
				required_requests = Math.ceil(subs.length / 100);
			
				for (; i < required_requests && i < ratelimit_remaining; i++) {
					promises.push(this.requester.oauthRequest({
						uri: "api/info", // only takes max of 100 subs at once
						qs: {
							sr_name: subs.slice(i*100, i*100 + 100).join(",")
						}
					}));
				}
				break;
			case "u/":
				required_requests = subs.length;

				for (; i < required_requests && i < ratelimit_remaining; i++) {
					promises.push(this.requester.oauthRequest({
						uri: `${subs[i]}/about`
					}));
				}
				break;
			default:
				break;
		}
		(i == ratelimit_remaining ? console.log(`user (${this.username}) ratelimit reached`) : null);

		const responses = await Promise.all(promises);

		switch (type) {
			case "r/":
				for (const listing of responses) {
					for (const sub of listing) {
						const sub_name = sub.display_name_prefixed;
						
						let sub_icon_url = "#";
						if (sub.icon_img) {
							sub_icon_url = sub.icon_img.split("?")[0];
						} else if (sub.community_icon) {
							sub_icon_url = sub.community_icon.split("?")[0];
						}
		
						this.new_data[category].item_sub_icon_urls[sub_name] = sub_icon_url;
					}
				}
				break;
			case "u/":
				for (const sub of responses) {
					const sub_name = `u/${sub.name}`;
	
					let sub_icon_url = "#";
					if (sub.icon_img) {
						sub_icon_url = sub.icon_img.split("?")[0];
					} else if (sub.subreddit?.display_name.icon_img) {
						sub_icon_url = sub.subreddit.display_name.icon_img.split("?")[0];
					} else if (sub.community_icon) {
						sub_icon_url = sub.community_icon.split("?")[0];
					} else if (sub.subreddit?.display_name.community_icon) {
						sub_icon_url = sub.subreddit.display_name.community_icon.split("?")[0];
					} else if (sub.snoovatar_img) {
						sub_icon_url = sub.snoovatar_img.split("?")[0];
					} else if (sub.subreddit?.display_name.snoovatar_img) {
						sub_icon_url = sub.subreddit.display_name.snoovatar_img.split("?")[0];
					}
	
					this.new_data[category].item_sub_icon_urls[sub_name] = sub_icon_url;
				}
				break;
			default:
				break;
		}
	}
	async get_new_item_icon_urls(category) {
		let r_subs = []; // actual subs
		let u_subs = []; // users as subs

		for (const sub of this.sub_icon_urls_to_get[category]) {
			if (sub.startsWith("r/")) {
				r_subs.push(sub);
			} else if (sub.startsWith("u/")) {
				u_subs.push(sub);
			}
		}

		(r_subs.length != 0 ? await this.request_item_icon_urls("r/", r_subs, category) : null);
		(u_subs.length != 0 ? await this.request_item_icon_urls("u/", u_subs, category) : null);
	}
	async update(io=null, socket_id=null) {
		console.log(`updating user (${this.username})`);

		let progress = (io ? 0 : null);
		const complete = (io ? 8 : null);

		this.requester = reddit.create_requester(cryptr.decrypt(this.reddit_api_refresh_token_encrypted));
		this.me = await this.requester.getMe();

		this.firebase_app = firebase.create_app(JSON.parse(cryptr.decrypt(this.firebase_service_acc_key_encrypted)), JSON.parse(cryptr.decrypt(this.firebase_web_app_config_encrypted)).databaseURL, this.username);
		this.firebase_db = firebase.get_db(this.firebase_app);

		this.new_data = {};
		this.sub_icon_urls_to_get = {};
		this.imported_fns_to_delete = {};
		
		const categories = ["saved", "created", "upvoted", "downvoted", "hidden", "awarded"];
		for (const category of categories) {
			this.new_data[category] = {
				items: {},
				item_sub_icon_urls: {}
			};
			
			this.sub_icon_urls_to_get[category] = new Set();
		}
		categories.pop();
		for (const category of categories) {
			this.imported_fns_to_delete[category] = null;
		}

		const s_promise = new Promise(async (resolve, reject) => {
			try {
				(this.firebase_app.isDeleted_ ? null : await this.sync_category("saved", "mixed"));
				(this.firebase_app.isDeleted_ ? null : await this.import_category("saved", "mixed"));
				(this.firebase_app.isDeleted_ ? null : await this.get_new_item_icon_urls("saved"));

				if (this.firebase_app.isDeleted_) {
					reject("firebase_app is deleted");
				} else {
					(io ? io.to(socket_id).emit("update progress", ++progress, complete) : null);
					resolve();
				}
			} catch (err) {
				err.extras = {
					category: "saved"
				};
				reject(err);
			}
		});

		const c_promise = new Promise(async (resolve, reject) => {
			try {
				if (!this.firebase_app.isDeleted_) {
					await Promise.all([
						this.sync_category("created", "posts"),
						this.sync_category("created", "comments")
					]);
				}
				(this.firebase_app.isDeleted_ ? null : await this.import_category("created", "mixed"));
				(this.firebase_app.isDeleted_ ? null : await this.get_new_item_icon_urls("created"));

				if (this.firebase_app.isDeleted_) {
					reject("firebase_app is deleted");
				} else {
					(io ? io.to(socket_id).emit("update progress", ++progress, complete) : null);
					resolve();
				}
			} catch (err) {
				err.extras = {
					category: "created"
				};
				reject(err);
			}
		});
		
		const u_promise = new Promise(async (resolve, reject) => {
			try {
				(this.firebase_app.isDeleted_ ? null : await this.sync_category("upvoted", "posts"));
				(this.firebase_app.isDeleted_ ? null : await this.import_category("upvoted", "posts"));
				(this.firebase_app.isDeleted_ ? null : await this.get_new_item_icon_urls("upvoted"));

				if (this.firebase_app.isDeleted_) {
					reject("firebase_app is deleted");
				} else {
					(io ? io.to(socket_id).emit("update progress", ++progress, complete) : null);
					resolve();
				}
			} catch (err) {
				err.extras = {
					category: "upvoted"
				};
				reject(err);
			}
		});
		
		const d_promise = new Promise(async (resolve, reject) => {
			try {
				(this.firebase_app.isDeleted_ ? null : await this.sync_category("downvoted", "posts"));
				(this.firebase_app.isDeleted_ ? null : await this.import_category("downvoted", "posts"));
				(this.firebase_app.isDeleted_ ? null : await this.get_new_item_icon_urls("downvoted"));

				if (this.firebase_app.isDeleted_) {
					reject("firebase_app is deleted");
				} else {
					(io ? io.to(socket_id).emit("update progress", ++progress, complete) : null);
					resolve();
				}
			} catch (err) {
				err.extras = {
					category: "downvoted"
				};
				reject(err);
			}
		});

		const h_promise = new Promise(async (resolve, reject) => {
			try {
				(this.firebase_app.isDeleted_ ? null : await this.sync_category("hidden", "posts"));
				(this.firebase_app.isDeleted_ ? null : await this.import_category("hidden", "posts"));
				(this.firebase_app.isDeleted_ ? null : await this.get_new_item_icon_urls("hidden"));

				if (this.firebase_app.isDeleted_) {
					reject("firebase_app is deleted");
				} else {
					(io ? io.to(socket_id).emit("update progress", ++progress, complete) : null);
					resolve();
				}
			} catch (err) {
				err.extras = {
					category: "hidden"
				};
				reject(err);
			}
		});

		const a_promise = new Promise(async (resolve, reject) => {
			try {
				(this.firebase_app.isDeleted_ ? null : await this.sync_category("awarded", "mixed"));
				(this.firebase_app.isDeleted_ ? null : await this.get_new_item_icon_urls("awarded"));

				if (this.firebase_app.isDeleted_) {
					reject("firebase_app is deleted");
				} else {
					(io ? io.to(socket_id).emit("update progress", ++progress, complete) : null);
					resolve();
				}
			} catch (err) {
				err.extras = {
					category: "awarded"
				};
				reject(err);
			}
		});

		await Promise.all([s_promise, c_promise, u_promise, d_promise, h_promise, a_promise]);

		try {
			await firebase.insert_data(this.firebase_db, this.new_data);
			await firebase.delete_imported_fns(this.firebase_db, this.imported_fns_to_delete);
			firebase.free_app(this.firebase_app).catch((err) => console.error(err));
			(io ? io.to(socket_id).emit("update progress", ++progress, complete) : null);
		} catch (err) {
			console.error(err);
			logger.error(`user (${this.username}) db update error (${err})`);

			if (utils.now_epoch() - this.email_notif.last_update_failed_notif_epoch >= 2592000) { // 30d
				email.send(this, "database update error notice", `your database could not be updated because: ${err}. please resolve this asap`).catch((err) => console.error(err));
				this.email_notif.last_update_failed_notif_epoch = utils.now_epoch();
				sql.update_user(this.username, {
					email_notif: JSON.stringify(this.email_notif)
				}).catch((err) => console.error(err));
			}

			return;
		}

		await sql.update_user(this.username, {
			category_sync_info: JSON.stringify(this.category_sync_info),
			last_updated_epoch: this.last_updated_epoch = utils.now_epoch()
		});
		(io ? io.to(socket_id).emit("update progress", ++progress, complete) : null);
		console.log(`updated user (${this.username})`);

		delete this.new_data;
		delete this.sub_icon_urls_to_get;
		delete this.imported_fns_to_delete;
	}
	async get_comment_from_reddit(comment_id) {
		const requester = reddit.create_requester(cryptr.decrypt(this.reddit_api_refresh_token_encrypted));
		
		const unfetched_comment = requester.getComment(comment_id);
		const fetched_comment = await unfetched_comment.fetch();
		
		const comment_content = fetched_comment.body;
		return comment_content;
	}
	async delete_item_from_reddit_acc(item_id, item_category, item_type) {
		const requester = reddit.create_requester(cryptr.decrypt(this.reddit_api_refresh_token_encrypted));
	
		let item = null;
		let item_fn = null; // https://www.reddit.com/dev/api/#fullnames
		switch (item_type) {
			case "post":
				item = requester.getSubmission(item_id);
				item_fn = `t3_${item_id}`;
				break;
			case "comment":
				item = requester.getComment(item_id);
				item_fn = `t1_${item_id}`;
				break;
			default:
				break;
		}
	
		let replace_latest_fn = null;
		if (item_category == "saved") {
			replace_latest_fn = (item_fn == this.category_sync_info.saved.latest_fn_mixed ? true : false);
		} else {
			replace_latest_fn = (item_fn == this.category_sync_info[item_category][`latest_fn_${item_type}s`] ? true : false);
		}
		
		switch (item_category) {
			case "saved":
				await item.unsave();
				break;
			case "created":
				await item.delete();
				break;
			case "upvoted":
			case "downvoted":
				await item.unvote();
				break;
			case "hidden":
				await item.unhide();
				break;
			default:
				break;
		}
	
		if (replace_latest_fn) {
			this.me = await requester.getMe();
			await this.replace_latest_fn(item_category, (item_category == "saved" ? "mixed" : `${item_type}s`));
			await sql.update_user(this.username, {
				category_sync_info: JSON.stringify(this.category_sync_info)
			});
		}
	}
	async purge() {
		await sql.update_user(this.username, {
			reddit_api_refresh_token_encrypted: null,
			category_sync_info: null,
			last_updated_epoch: null,
			last_active_epoch: null,
			email_encrypted: null,
			email_notif: null,
			firebase_service_acc_key_encrypted: null,
			firebase_web_app_config_encrypted: null
		});
		delete usernames_to_socket_ids[this.username];
		console.log(`purged user (${this.username})`);
	}
}

async function fill_usernames_to_socket_ids() {
	const rows = await sql.get_all_non_purged_users();
	for (const row of rows) {
		usernames_to_socket_ids[row.username] = null;
	}
}

async function get(username, existence_check=false) {
	(existence_check ? console.log(`checking if user (${username}) exists`) : console.log(`getting user (${username})`));

	const result = await sql.get_user(username);
	if (result == undefined) {
		throw new Error(`user (${username}) dne`);
	} else {
		const plain_object = result;
		(plain_object.last_updated_epoch ? plain_object.last_updated_epoch = Number.parseInt(plain_object.last_updated_epoch) : null);
		plain_object.last_active_epoch = Number.parseInt(plain_object.last_active_epoch);
	
		const user = Object.assign(new User(null, null, true), plain_object);
		return user;
	}
}

async function update_all(io) {
	console.log("update all started");
	update_all_completed = false;

	const all_usernames = Object.keys(usernames_to_socket_ids);
	for (const username of all_usernames) {
		let user = null;
		try {
			user = await get(username);

			if (user.last_updated_epoch) {
				if (utils.now_epoch() - user.last_active_epoch >= 15552000) { // 6mo
					if (utils.now_epoch() - user.email_notif.last_inactive_notif_epoch >= 7776000) { // 3mo
						email.send(user, "account inactivity notice", "you have not used eternity for 6 or more consecutive months at this time. as such, your eternity account has been marked inactive and new Reddit data will not continue to sync to your database. to resolve this, log in to eternity").catch((err) => console.error(err));
						user.email_notif.last_inactive_notif_epoch = utils.now_epoch();
						sql.update_user(user.username, {
							email_notif: JSON.stringify(user.email_notif)
						}).catch((err) => console.error(err));
					}
				} else if (utils.now_epoch() - user.last_updated_epoch >= 30) {
					const pre_update_category_sync_info = JSON.parse(JSON.stringify(user.category_sync_info));

					await user.update();
					
					const post_update_category_sync_info = user.category_sync_info;
					
					const socket_id = usernames_to_socket_ids[user.username];
					if (socket_id) {
						const categories_w_new_data = [];
						for (const category in user.category_sync_info) {
							(post_update_category_sync_info[category].latest_new_data_epoch > pre_update_category_sync_info[category].latest_new_data_epoch ? categories_w_new_data.push(category) : null);
						}
						(categories_w_new_data.length > 0 ? io.to(socket_id).emit("show refresh alert", categories_w_new_data) : null);

						io.to(socket_id).emit("store last updated epoch", user.last_updated_epoch);
					}
				}
			}
		} catch (err) {
			if (err != `Error: user (${username}) dne`) {
				console.error(err);
				logger.error(`user (${username}) update error (${err})`);

				(user.firebase_app ? firebase.free_app(user.firebase_app).catch((err) => console.error(err)) : null);

				if (err.statusCode == 403 && err.options.qs.before) {
					try {
						switch (err.extras.category) {
							case "saved":
							case "awarded":
								await user.replace_latest_fn(err.extras.category, "mixed");
								break;
							case "created":
								await Promise.all([
									user.replace_latest_fn(err.extras.category, "posts"),
									user.replace_latest_fn(err.extras.category, "comments")
								]);
								break;
							case "upvoted":
							case "downvoted":
							case "hidden":
								await user.replace_latest_fn(err.extras.category, "posts");
								break;
							default:
								break;
						}
						await sql.update_user(user.username, {
							category_sync_info: JSON.stringify(user.category_sync_info)
						});
					} catch (err) {
						console.error(err);
						logger.error(`user (${username}) replace_latest_fn error (${err})`);
					}
				}
			}
			
		}
	}

	update_all_completed = true;
	console.log("update all completed");
}
function cycle_update_all(io) {
	update_all(io).catch((err) => console.error(err));

	setInterval(() => {
		(update_all_completed ? update_all(io).catch((err) => console.error(err)) : null);
	}, 60000); // 1min
}

export {
	User,
	usernames_to_socket_ids,
	socket_ids_to_usernames,
	fill_usernames_to_socket_ids,
	get,
	cycle_update_all
};
