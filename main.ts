// Suppress specific warning types
process.env.NODE_NO_WARNINGS = "1";
process.env.NODE_OPTIONS = "--no-warnings";
process.removeAllListeners("warning");
process.removeAllListeners("ExperimentalWarning");

// Ensure UTF-8 encoding for input and output
process.stdin.setEncoding("utf8");
process.stdout.setEncoding("utf8");

import { extender, showAllBalances } from "./src/bot";
import { closeAcc, closeParticularAcc } from "./src/retrieve";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

import promptSync from "prompt-sync";
import figlet from "figlet";
import chalk from "chalk";
import { API_KEY, wallet, connection } from "./config";
import { machineIdSync } from "node-machine-id";
import axios from "axios";
import fs from "fs";

const prompt = promptSync();

async function validateLicense(product: string): Promise<void> {
	try {
		const hwid = machineIdSync();
		const response = await axios.post("https://license-endpoint-production.up.railway.app/validate", {
			api_key: API_KEY,
			hwid,
			product,
		});

		if (response.data.message === "API key is valid, HWID matches, and product is allowed") {
			console.log(chalk.green("\nLicense validated successfully"));
			lox = true;
		} else {
			console.log(chalk.red("\nLicense validation failed:", response.data.message));
			process.exit(1); // Exit the script
		}
	} catch (error: any) {
		console.error(chalk.red("\nError validating license:"), error.response ? error.response.data : error.message);
		console.log(chalk.green("\nGet one at solana-scripts.com\n"));
		process.exit(1); // Exit the script
	}
}

// Function to fetch balance
async function getBalance(keypair: Keypair): Promise<number> {
	const balance = await connection.getBalance(keypair.publicKey);
	return balance / LAMPORTS_PER_SOL; // Convert lamports to SOL
}

let lox = false;

async function run() {
	const args = process.argv.slice(2);
	let running = true;

	// If the '-c' flag is provided, read the config file and run extender with it
	if (args.length > 1 && args[0] === "-c") {
		const configFilePath = args[1];
		const config = JSON.parse(fs.readFileSync(configFilePath, "utf8"));
		await extender(config);
		return;
	}

	// Create ASCII art using figlet
	const asciiArt = figlet.textSync("bigmovers", {
		font: "Standard",
		horizontalLayout: "default",
		verticalLayout: "default",
		width: 80,
		whitespaceBreak: true,
	});

	// Color the ASCII art using chalk
	const coloredAsciiArt = chalk.cyan(asciiArt);

	while (running) {
		// Clear the console
		console.clear();

		// Display the colored ASCII art
		console.log(coloredAsciiArt);
		console.log(chalk.yellow("solana-scripts.com"));
		console.log(chalk.magenta("Join our DISCORD for SUPPORT"));

		if (!lox) {
			await validateLicense("natural-auto");
		}

		const walletBalance = await getBalance(wallet);
		// Display balances
		console.log("");
		console.log(chalk.green("Funder Balance: "), chalk.cyan(`${walletBalance.toFixed(4)} SOL`));

		console.log(chalk.green("\n==================== Menu ===================="));
		console.log(chalk.green("1. Spam AUTO Random Buyers"));
		console.log(chalk.red("2. Retrieve SOL ALL WALLETS"));
		console.log(chalk.blue("3. Retrieve SOL FROM PARTICULAR WALLET NUMBER"));
		console.log(chalk.cyan("4. Show All Balances"));

		console.log(chalk.white("Type 'exit' to quit."));
		console.log(chalk.green("==============================================="));

		const answer = prompt(chalk.yellow("Choose an option or 'exit': "));

		switch (answer) {
			case "1":
				await extender();
				break;
			case "2":
				await closeAcc();
				break;
			case "3":
				const walletNumber = prompt(chalk.yellow("From Keypairs folders, enter the wallet number from the folders: "));
				if (Number(walletNumber) > 0) {
					await closeParticularAcc(Number(walletNumber));
				} else {
					console.log(chalk.red("Invalid wallet number, please enter a valid number."));
				}
				break;
			case "4":
				const marketID = prompt(chalk.yellow("Enter your Pair ID: "));
				await showAllBalances(marketID);
				break;
			case "exit":
				running = false;
				break;
			default:
				console.log(chalk.red("Invalid option, please choose again."));
		}
	}

	console.log(chalk.green("Exiting..."));
	process.exit(0);
}

run().catch((err) => {
	console.error(chalk.red("Error:"), err);
});
