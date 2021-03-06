import * as Discord from 'discord.js';
//const os = require('node-os-utils'); //removed due to security vulnerability
import * as _os from 'os';
import {spawnSync} from 'child_process';

const id = '544241564071755777';//channel id

const MAX_INTERVAL = 600;
const MIN_INTERVAL = 1;
var INTERVAL = 30;//default value

const SHELL_OPTIONS = {shell: true, encoding: 'ascii'};
const hardspace = decodeURI('%F3%A0%80%80%F3%A0%80%80%20%F3%A0%80%80%F3%A0%80%80');

let threads_data: number[] = new Array(_os.cpus().length).fill(0);
let prev_total: number[] = new Array(_os.cpus().length).fill(0);
let prev_idle: number[] = new Array(_os.cpus().length).fill(0);

var current_timeout: number | null = null;

interface MessageSchema {
	process_count: number;
	thread_usage: number[];

	used_memory: number;
	total_memory: number;
	used_swap: number;
	total_swap: number;

	disk_usage: string;

	//downloadMb: number;
	//uploadMb: number;
}

function genProgressBar(percent: number, bar_len = 20) {//percent: [0; 1]
	let out = '';
	for(var j=0; j<bar_len; j++)
		out += j < Math.round(percent*bar_len) ? '■' : '□';
	return out;
}

function generateMessage(data: MessageSchema) {
	let mem_t = data.total_memory;
	let mem_u = data.used_memory;
	let swap_t = data.total_swap;
	let swap_u = data.used_swap;

	let ram_used = `${(mem_u/mem_t)*100|0}% (${(mem_u).toFixed(2)}/${(mem_t).toFixed(2)})`;
	let swap_used = `${(swap_u/swap_t)*100|0}% (${(swap_u).toFixed(2)}/${(swap_t).toFixed(2)})`;

	var embed = new Discord.RichEmbed().setColor('#4FC3F7')//4FC3F7 - cyan
		.addField('Ilość procesów', data.process_count)
		.addField('Obciążenie rdzeni', data.thread_usage.map((tu, i) => {
			let percent_str = `${Math.round(tu)}%`;
			let offset = 6 - percent_str.length;
			for(var j=0; j<offset; j++)
				percent_str += hardspace;
			return percent_str + genProgressBar(tu/100);
		}).join('\n'))
		.addField('Zużycie pamięci (GB)', 
			`${genProgressBar(mem_u/mem_t)}\nRAM: ${ram_used}\nSWAP: ${swap_used}`)
		.addField('Zużycie dysku', 
			`${data.disk_usage}\n${genProgressBar(parseInt(data.disk_usage.replace('%', ''))/100)}`)
		//.addField('Obciążenie sieci', 
		//	`Download: ${data.downloadMb} Mb/s\nUpload: ${data.uploadMb} Mb/s`)
		.addField('Ostatnia aktualizacja', new Date().toLocaleTimeString('en-US', {hour12: false}))
		.setFooter(`Odświeżanie co ${INTERVAL}s`);
	return embed;
}

async function startRefreshing(msg: Discord.Message) {
	//let proc_info = await os.proc.totalProcesses();
	let proc_info = 0;
	try {
		proc_info = parseInt(
			spawnSync(`top -bn1 | awk 'NR > 7 && $8 ~ /R|S|D|T/ { print $12 }' | wc -l`, SHELL_OPTIONS).output.toString().replace(/[^\d]*/gi, '') 
		);
	}
	catch(e) {
		console.error(e);
	}

	let mem_info: {used: number, total: number};// = await os.mem.info();
	let swap_info: {used: number, total: number};
	//let net_info = await os.netstat.inOut();

	let free_info: string[];
	try {
		free_info = spawnSync(`free | tail -n -2 | awk '{print $2, $3}'`, SHELL_OPTIONS).output
			.filter(x => x && x.length>0).toString().split('\n');
		
		mem_info = {
			total: ( parseInt(free_info[0].split(' ')[0]) / 1024 / 1024 ),
			used: ( parseInt(free_info[0].split(' ')[1]) / 1024 / 1024 )
		};

		swap_info = {
			total: ( parseInt(free_info[1].split(' ')[0]) / 1024 / 1024 ),
			used: ( parseInt(free_info[1].split(' ')[1]) / 1024 / 1024 )
		};
	}
	catch(e) { 
		console.error(e);
		msg.edit(e);
		return;
	}

	var disk_info;

	try {
		disk_info = spawnSync(`df | grep /$ | awk '{print $5};'`, SHELL_OPTIONS).output
			.filter(x => x && x.length>0).toString().trim();
	}
	catch(e) {
		disk_info = '0%';
	}

	var cpus = _os.cpus();
	
	let ii=0;
	for(var cpu of cpus) {
		let idle = cpu.times.idle;
		let total = cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + idle;

		let idle_diff = idle - prev_idle[ii];
		if(idle_diff > 0) {
			let total_diff = total - prev_total[ii];
			threads_data[ii] = (1 - idle_diff/total_diff) * 100;
		}

		prev_total[ii] = total;
		prev_idle[ii] = idle;
		ii++;
	}

	var data: MessageSchema = {
		process_count: proc_info,
		thread_usage: threads_data,
		used_memory: mem_info.used,
		total_memory: mem_info.total,
		used_swap: swap_info.used,
		total_swap: swap_info.total,
		disk_usage: disk_info,
		//downloadMb: net_info.total.inputMb,
		//uploadMb: net_info.total.outputMb
	};

	msg.edit(generateMessage(data));

	current_timeout = setTimeout(startRefreshing, 1000*INTERVAL, msg);
}

function clearChannel(channel: Discord.TextChannel) {
	return channel.fetchMessages().then(messages => {
		messages.forEach(m => m.delete());
	}).catch(err => {
		console.log('Error while deleting channel messages');
		console.log(err);
	});
}

function printHelp(message: Discord.Message) {
	message.channel.send(
		`\`!interval [liczba]\` - ustawia częstotliwość odświeżeń w sekundach (min: ${MIN_INTERVAL}, max: ${MAX_INTERVAL})`)
	.then(m => {
		//delete help message after 30 seconds
		setTimeout(() => {
			if(m instanceof Discord.Message)
				m.delete();
		}, 1000*30);
	}).catch(() => {});//ignore errors
}

var StatusApp = {
	CHANNEL_ID: id,

	init: async (bot: Discord.Client, prevent_channel_clear = false) => {
		var msg: Discord.Message | Discord.Message[] | undefined;
		
		var target = bot.channels.get(id);
		if(!target || !(target instanceof Discord.TextChannel)) {
			console.error('Error while fetching user/channel (usage app)');
			return;
		}

		var messages = await (<Discord.TextChannel>target).fetchMessages();
		var msg_arr = messages.array();

		if(prevent_channel_clear === false) {
			if(msg_arr.length === 1 && msg_arr[0].author.bot)
				msg = msg_arr[0];
			else {
				if(msg_arr.length > 1)
					await clearChannel(target);
				msg = await target.send('Ładowanko...');
			}
		}
		else {
			if(msg_arr.length > 0)
				msg = msg_arr[msg_arr.length-1];
			else
				msg = await target.send('Ładowanko...');
		}

		if(msg instanceof Discord.Message)
			startRefreshing(msg);//MainMessage = msg;
		else {
			console.error('Error while creating message (status app)');
			return;
		}
	},

	handleMessage: async function(message: Discord.Message, bot: Discord.Client) {
		let args = message.content.substring(1).split(' ');
	    let cmd = (args.shift() || '').replace(/^dev_/i, '');

	    switch(cmd) {
	    	default: 
	    		printHelp(message);
	    		break;
	    	case 'interval': {
	    		try {
	    			INTERVAL = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, parseInt(args[0])));
	    		}
	    		catch(e) {}
	    		if(current_timeout) {
	    			clearTimeout(current_timeout);
	    			current_timeout = null;
	    		}
	    		message.channel.send(`Interval zmieniony na ${INTERVAL} sekund`).then(m => {
					setTimeout(() => {
						if(m instanceof Discord.Message)
							m.delete();
					}, 1000*5);//delete after 5 seconds
				}).catch(() => {});//ignore errors
				this.init(bot, true);
	    	}	break;
	    }

		message.delete().catch(()=>{});
	}
};

export default StatusApp;