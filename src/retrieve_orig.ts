import { Keypair, PublicKey, LAMPORTS_PER_SOL, TransactionMessage, SystemProgram, VersionedTransaction, TransactionInstruction, Blockhash } from "@solana/web3.js";
import { connection, wallet, tipAcct, isMainnet, provider } from "../config";
import { lookupTableProvider } from "./clients/LookupTableProvider";
import * as spl from "@solana/spl-token";
import fs from "fs";
import path from "path";
import promptSync from "prompt-sync";
import { makeSwap, makeCPMMSwap, sendBundle, sendTransactionsSequentially } from "./bot"; // <-- Make sure this is your updated makeCPMMSwap
import { derivePoolKeys } from "./clients/poolKeysReassigned";
import { formatAmmKeysById } from "./clients/formatAmm";
import chalk from "chalk";
import { retryOperation, pause } from "./clients/utils";
import { burnAccount } from "./utils";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import BN from "bn.js";
import PumpSwapSDK from "./pump_swap_sdk";
// Raydium/Solana imports for CPMM detection
import { Raydium, CpmmRpcData, WSOLMint } from "@raydium-io/raydium-sdk-v2";

require("dotenv").config();

const DEBUG = process.env.DEBUG?.toLowerCase() === "true";

const prompt = promptSync();
const keypairsDir = "./src/keypairs";

/**
 * Close all accounts for a given Pair ID, selling any tokens to WSOL if CPMM, Non-CPMM, or PumpSwap.
 */
export async function closeAcc() {
	console.clear();
	console.log(chalk.red("\n==================== Retrieve SOL ===================="));
	console.log(chalk.yellow("Follow the instructions below to retrieve SOL.\n"));

	const marketID = prompt(chalk.cyan("Enter your Pair ID or Token Mint: "));
	const keypairsPath = path.join(keypairsDir, marketID);

	const delaySell = prompt(chalk.cyan("Delay between sells in MS (Ex. 300): "));
	const delaySellIn = parseInt(delaySell, 10);

	if (!fs.existsSync(keypairsPath)) {
		console.log(chalk.red(`No keypairs found for Pair ID/Token: ${marketID}`));
		process.exit(0);
	}

	const jitoTipAmtInput = prompt(chalk.cyan("Jito tip in Sol (Ex. 0.01): "));
	const jitoTipAmt = parseFloat(jitoTipAmtInput) * LAMPORTS_PER_SOL;

	if (jitoTipAmtInput) {
		const tipValue = parseFloat(jitoTipAmtInput);
		if (tipValue >= 0.1) {
			console.log(chalk.red("Error: Tip value is too high. Please enter a value less than or equal to 0.1."));
			process.exit(0);
		}
	} else {
		console.log(chalk.red("Error: Invalid input. Please enter a valid number."));
		process.exit(0);
	}

	// Try to interpret marketID as both a pool ID and a token mint
	const marketIdPubkey = new PublicKey(marketID);

	// First check if it's a PumpSwap pool
	let isPumpSwap = false;
	let pumpSwapBaseMint: PublicKey | null = null;

	try {
		console.log(chalk.blue("Checking if this is a PumpSwap pool..."));
		const pSwap = new PumpSwapSDK();
		// If marketID is a token mint, try to get the pool
		const pumpSwapPool = await pSwap.getPumpSwapPool(marketIdPubkey);
		if (pumpSwapPool) {
			isPumpSwap = true;
			pumpSwapBaseMint = marketIdPubkey;
			console.log(chalk.green(`Detected PumpSwap pool for token: ${marketID}`));
		}
	} catch (error) {
		// Not a PumpSwap pool or not a valid mint
		isPumpSwap = false;
		console.log(chalk.yellow(`Not a PumpSwap pool: ${error instanceof Error ? error.message : String(error)}`));
	}

	// If not PumpSwap, check if it's CPMM
	let poolInfo: CpmmRpcData | null = null;
	let isCPMM = false;
	let keys = null;
	const poolId = new PublicKey(marketID);

	if (!isPumpSwap) {
		const dummyOwner = Keypair.generate();
		const raydium = await Raydium.load({
			owner: dummyOwner,
			connection,
			cluster: "mainnet",
			disableFeatureCheck: true,
			disableLoadToken: true,
			blockhashCommitment: "finalized",
		});

		try {
			poolInfo = await raydium.cpmm.getRpcPoolInfo(marketID);
			isCPMM = true;
			console.log(chalk.green(`Detected CPMM pool: ${marketID}`));
		} catch {
			isCPMM = false;
			console.log(chalk.yellow(`Not a CPMM pool: ${marketID}`));
		}

		// If not CPMM, we fetch standard Raydium/OpenBook keys
		if (!isCPMM) {
			try {
				const poolPrompt = await formatAmmKeysById(marketID);
				const derivedMarketId = poolPrompt.marketId;
				keys = await derivePoolKeys(new PublicKey(derivedMarketId));

				if (keys === null) {
					console.log(chalk.red("Error fetching poolkeys"));
					process.exit(0);
				}
				console.log(chalk.green(`Detected standard Raydium pool: ${marketID}`));
			} catch (error) {
				console.log(chalk.red(`Could not identify market type for ID: ${marketID}`));
				console.log(chalk.red(error instanceof Error ? error.message : String(error)));
				process.exit(0);
			}
		}
	}

	// Now proceed with closing all keypairs in this directory
	let keypairsExist = checkKeypairsExist(keypairsPath);

	while (keypairsExist) {
		const keypairs = loadKeypairs(keypairsPath);
		let txsSigned: VersionedTransaction[] = [];
		let maxSize = 0;

		for (let i = 0; i < keypairs.length; i++) {
			let { blockhash } = await retryOperation(() => connection.getLatestBlockhash());

			const keypair = keypairs[i];
			console.log(chalk.blue(`Processing keypair ${i + 1}/${keypairs.length}:`), keypair.publicKey.toString());

			// Handle PumpSwap
			if (isPumpSwap && pumpSwapBaseMint) {
				console.log(chalk.blue("Processing PumpSwap token..."));
				const instructionsForChunk: TransactionInstruction[] = [];
				const tokenAcc = await spl.getAssociatedTokenAddress(pumpSwapBaseMint, keypair.publicKey);
				const wsolAcc = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, keypair.publicKey);

				// Verify token account exists and has balance
				let tokenAccountExists = false;
				let tokenAmount = 0;
				let tokenAmountString = "0";

				try {
					const accountInfo = await connection.getAccountInfo(tokenAcc);
					if (accountInfo !== null) {
						const balanceResponse = await connection.getTokenAccountBalance(tokenAcc);
						tokenAmount = balanceResponse.value.uiAmount || 0;
						tokenAmountString = balanceResponse.value.uiAmountString || "0";
						tokenAccountExists = accountInfo !== null && tokenAmount > 0;

						console.log(chalk.blue(`Token account exists: ${tokenAccountExists}`));
						console.log(chalk.blue(`Token balance: ${tokenAmountString} (${tokenAmount})`));
					} else {
						console.log(chalk.yellow("Token account doesn't exist"));
					}
				} catch (error) {
					console.log(chalk.red(`Error checking token account: ${error}`));
				}

				const wsolAccountExists = await checkTokenAccountExists(wsolAcc);

				// Check if the keypair account has any SOL balance
				const solBalance = await connection.getBalance(keypair.publicKey);
				const minBalanceForRent = 10000; // Minimum balance to be worth transferring

				// Only proceed if either token account exists with balance or WSOL account exists or SOL balance > minimum
				if (tokenAccountExists || wsolAccountExists || solBalance > minBalanceForRent) {
					if (solBalance > minBalanceForRent) {
						console.log(chalk.green(`Account has ${solBalance / LAMPORTS_PER_SOL} SOL, will transfer to main wallet`));
					}

					if (tokenAccountExists) {
						// Sell instructions
						const sellInstruction = await sell_pump_amm(pumpSwapBaseMint, keypair, Number(tokenAmountString), 0);

						if (sellInstruction) {
							instructionsForChunk.push(...sellInstruction);
							console.log(chalk.green(`Added PumpSwap sell instructions for ${tokenAmountString} tokens`));
						} else {
							console.log(chalk.yellow("Failed to create sell instructions"));
						}

						// Burn token account
						const baseMintTokenProgram = await getTokenProgramId(pumpSwapBaseMint);
						let baseTokenBurnInstruction = await burnAccount(wallet, keypair, connection, tokenAcc, baseMintTokenProgram);
						instructionsForChunk.push(...baseTokenBurnInstruction);
					}

					if (wsolAccountExists) {
						// Burn WSOL account
						let wsolBurnInstruction = await burnAccount(wallet, keypair, connection, wsolAcc, spl.TOKEN_PROGRAM_ID);
						instructionsForChunk.push(...wsolBurnInstruction);
					}

					// Drain leftover SOL from the ephemeral keypair to main wallet
					const balance = await connection.getBalance(keypair.publicKey);
					const feeEstimate = 10000;
					const transferAmount = balance - feeEstimate > 0 ? balance - feeEstimate : 0;

					const drainBalanceIxn = SystemProgram.transfer({
						fromPubkey: keypair.publicKey,
						toPubkey: wallet.publicKey,
						lamports: transferAmount,
					});
					instructionsForChunk.push(drainBalanceIxn);

					// Jito tip
					const tipSwapIxn = SystemProgram.transfer({
						fromPubkey: wallet.publicKey,
						toPubkey: tipAcct,
						lamports: BigInt(jitoTipAmt),
					});
					instructionsForChunk.push(tipSwapIxn);

					// Compile the transaction
					const message = new TransactionMessage({
						payerKey: keypair.publicKey,
						recentBlockhash: blockhash,
						instructions: instructionsForChunk,
					}).compileToV0Message();

					const versionedTx = new VersionedTransaction(message);
					versionedTx.sign([wallet, keypair]);

					txsSigned.push(versionedTx);
					maxSize++;
				} else {
					console.log(chalk.yellow("No token, WSOL, or significant SOL balance found. Skipping transaction."));
					deleteKeypairFile(keypair, keypairsPath);
				}
			}
			// Handle CPMM or Non-CPMM
			else {
				const WSOLataKeypair = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, keypair.publicKey);
				if (await checkTokenAccountExists(WSOLataKeypair)) {
					const instructionsForChunk: TransactionInstruction[] = [];

					if (!isCPMM && keys) {
						// Non-CPMM => Raydium/OpenBook
						let useQuoteMint: boolean;
						if (keys.quoteMint.toBase58() === "So11111111111111111111111111111111111111112") {
							useQuoteMint = false;
						} else {
							useQuoteMint = true;
						}
						const baseataKeypair = useQuoteMint
							? await spl.getAssociatedTokenAddress(new PublicKey(keys.quoteMint), keypair.publicKey)
							: await spl.getAssociatedTokenAddress(new PublicKey(keys.baseMint), keypair.publicKey);

						// SELL => reverse = true
						const { sellIxs } = makeSwap(keys, WSOLataKeypair, baseataKeypair, true, keypair);
						instructionsForChunk.push(...sellIxs);

						const baseMintTokenProgram = useQuoteMint ? await getTokenProgramId(keys.quoteMint) : await getTokenProgramId(keys.baseMint);
						let wsolBurnInstruction = await burnAccount(wallet, keypair, connection, WSOLataKeypair, spl.TOKEN_PROGRAM_ID);
						instructionsForChunk.push(...wsolBurnInstruction);
						let baseTokenBurnInstruction = await burnAccount(wallet, keypair, connection, baseataKeypair, baseMintTokenProgram);
						instructionsForChunk.push(...baseTokenBurnInstruction);
					} else if (isCPMM && poolInfo) {
						// CPMM => use new makeCPMMSwap signature with direction = "sell"
						let baseMint: PublicKey, quoteMint: PublicKey;
						if (poolInfo.mintA.equals(WSOLMint)) {
							baseMint = poolInfo.mintA; // WSOL
							quoteMint = poolInfo.mintB;
						} else if (poolInfo.mintB.equals(WSOLMint)) {
							baseMint = poolInfo.mintB; // WSOL
							quoteMint = poolInfo.mintA;
						} else {
							baseMint = poolInfo.mintA;
							quoteMint = poolInfo.mintB;
						}

						// The user presumably holds the "other" token if we're selling to WSOL
						const userTokenMint = baseMint.equals(WSOLMint) ? quoteMint : baseMint;
						const otherTokenATA = await spl.getAssociatedTokenAddress(userTokenMint, keypair.publicKey);

						const { swapIxs } = await makeCPMMSwap(
							connection,
							poolId,
							poolInfo,
							spl.NATIVE_MINT,
							WSOLataKeypair, // wSol ATA
							userTokenMint, // which token the user is selling
							otherTokenATA, // user's other token ATA
							keypair,
							"sell"
						);
						instructionsForChunk.push(...swapIxs);

						const baseMintTokenProgram = await getTokenProgramId(userTokenMint);
						let wsolBurnInstruction = await burnAccount(wallet, keypair, connection, WSOLataKeypair, spl.TOKEN_PROGRAM_ID);
						instructionsForChunk.push(...wsolBurnInstruction);
						let baseTokenBurnInstruction = await burnAccount(wallet, keypair, connection, otherTokenATA, baseMintTokenProgram);
						instructionsForChunk.push(...baseTokenBurnInstruction);
					}

					// Drain leftover SOL from the ephemeral keypair to main wallet
					const balance = await connection.getBalance(keypair.publicKey);
					const feeEstimate = 10000;
					const transferAmount = balance - feeEstimate > 0 ? balance - feeEstimate : 0;

					const drainBalanceIxn = SystemProgram.transfer({
						fromPubkey: keypair.publicKey,
						toPubkey: wallet.publicKey,
						lamports: transferAmount,
					});
					instructionsForChunk.push(drainBalanceIxn);

					// Jito tip
					const tipSwapIxn = SystemProgram.transfer({
						fromPubkey: wallet.publicKey,
						toPubkey: tipAcct,
						lamports: BigInt(jitoTipAmt),
					});
					instructionsForChunk.push(tipSwapIxn);

					// Compile the transaction
					const message = new TransactionMessage({
						payerKey: keypair.publicKey,
						recentBlockhash: blockhash,
						instructions: instructionsForChunk,
					}).compileToV0Message();

					const versionedTx = new VersionedTransaction(message);
					versionedTx.sign([wallet, keypair]);

					txsSigned.push(versionedTx);
					maxSize++;
				} else {
					// Check if the keypair has SOL balance even if no token accounts
					const solBalance = await connection.getBalance(keypair.publicKey);
					const minBalanceForRent = 10000;

					if (solBalance > minBalanceForRent) {
						console.log(chalk.green(`Account has ${solBalance / LAMPORTS_PER_SOL} SOL, will transfer to main wallet`));

						const instructionsForChunk: TransactionInstruction[] = [];

						// Drain SOL balance
						const feeEstimate = 10000;
						const transferAmount = solBalance - feeEstimate > 0 ? solBalance - feeEstimate : 0;

						const drainBalanceIxn = SystemProgram.transfer({
							fromPubkey: keypair.publicKey,
							toPubkey: wallet.publicKey,
							lamports: transferAmount,
						});
						instructionsForChunk.push(drainBalanceIxn);

						// Jito tip
						const tipSwapIxn = SystemProgram.transfer({
							fromPubkey: wallet.publicKey,
							toPubkey: tipAcct,
							lamports: BigInt(jitoTipAmt),
						});
						instructionsForChunk.push(tipSwapIxn);

						// Compile transaction
						const message = new TransactionMessage({
							payerKey: keypair.publicKey,
							recentBlockhash: blockhash,
							instructions: instructionsForChunk,
						}).compileToV0Message();

						const versionedTx = new VersionedTransaction(message);
						versionedTx.sign([wallet, keypair]);

						txsSigned.push(versionedTx);
						maxSize++;
					} else {
						console.log(chalk.yellow(`Skipping keypair with zero balance:`), keypair.publicKey.toString());
						deleteKeypairFile(keypair, keypairsPath);
					}
				}
			}

			// Send in batches of 5
			if (maxSize === 5 || i === keypairs.length - 1) {
				if (txsSigned.length > 0) {
					if (DEBUG) {
						for (const tx of txsSigned) {
							try {
								const simulationResult = await connection.simulateTransaction(tx, { commitment: "confirmed" });
								if (simulationResult.value.err) {
									const errorMessage = `Simulation tx error: ${JSON.stringify(simulationResult.value.err, null, 2)}`;
									fs.appendFileSync("errorlog.txt", `${new Date().toISOString()} - ${errorMessage}\n`);
									console.log(chalk.red("Error simulating saved to errorlog.txt"));
								} else {
									console.log("Transaction simulation success.");
								}
							} catch (error) {
								console.error("Error during simulation:", error);
							}
						}
					}
					await sendBundleWithRetry(txsSigned);
					txsSigned = [];
					maxSize = 0;
					console.log(chalk.blue(`Waiting ${delaySellIn} ms`));
					await delay(delaySellIn);
				}
			}
			console.log("");
		}
		keypairsExist = checkKeypairsExist(keypairsPath);
	}

	console.log(chalk.green("All transactions processed and no more keypairs left."));
	await pause();
}

/**
 * Closes a *specific* chunk of accounts for the given Pair ID (used in your "extender").
 * Also does CPMM vs. Non-CPMM vs. PumpSwap detection.
 */
export async function closeSpecificAcc(keypairs: Keypair[], marketID: string, jitoTip: number, block: string | Blockhash) {
	const keypairsPath = path.join(keypairsDir, marketID);

	if (!fs.existsSync(keypairsPath)) {
		console.log(chalk.red(`No keypairs found for Pair ID: ${marketID}`));
		return;
	}

	// Try to interpret marketID as both a pool ID and a token mint
	const marketIdPubkey = new PublicKey(marketID);

	// First check if it's a PumpSwap pool
	let isPumpSwap = false;
	let pumpSwapBaseMint: PublicKey | null = null;

	try {
		console.log(chalk.blue("Checking if this is a PumpSwap pool..."));
		const pSwap = new PumpSwapSDK();
		// If marketID is a token mint, try to get the pool
		const pumpSwapPool = await pSwap.getPumpSwapPool(marketIdPubkey);
		if (pumpSwapPool) {
			isPumpSwap = true;
			pumpSwapBaseMint = marketIdPubkey;
			console.log(chalk.green(`Detected PumpSwap pool for token: ${marketID}`));
		}
	} catch (error) {
		// Not a PumpSwap pool or not a valid mint
		isPumpSwap = false;
		console.log(chalk.yellow(`Not a PumpSwap pool: ${error instanceof Error ? error.message : String(error)}`));
	}

	// If not PumpSwap, check if CPMM
	let poolInfo: CpmmRpcData | null = null;
	let isCPMM = false;
	let keys = null;
	const poolId = new PublicKey(marketID);

	if (!isPumpSwap) {
		const dummyOwner = Keypair.generate();
		const raydium = await Raydium.load({
			owner: dummyOwner,
			connection,
			cluster: "mainnet",
			disableFeatureCheck: true,
			disableLoadToken: true,
			blockhashCommitment: "finalized",
		});

		try {
			poolInfo = await raydium.cpmm.getRpcPoolInfo(marketID);
			isCPMM = true;
		} catch {
			isCPMM = false;
		}

		if (!isCPMM) {
			const poolPrompt = await formatAmmKeysById(marketID);
			const derivedMarketId = poolPrompt.marketId;
			keys = await derivePoolKeys(new PublicKey(derivedMarketId));
			if (keys === null) {
				console.log(chalk.red("Error fetching poolkeys"));
				return;
			}
		}
	}

	const BundledTxns: VersionedTransaction[] = [];

	for (let i = 0; i < keypairs.length; i++) {
		const keypair = keypairs[i];

		// Handle PumpSwap case
		if (isPumpSwap && pumpSwapBaseMint) {
			const instructionsForChunk: TransactionInstruction[] = [];
			const tokenAcc = await spl.getAssociatedTokenAddress(pumpSwapBaseMint, keypair.publicKey);
			const wsolAcc = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, keypair.publicKey);

			// Verify accounts exist
			const tokenAccountExists = await checkTokenAccountExists(tokenAcc);
			const wsolAccountExists = await checkTokenAccountExists(wsolAcc);

			if (tokenAccountExists) {
				// Get token balance for selling
				const tokenBalance = await connection.getTokenAccountBalance(tokenAcc);

				// Sell instructions - convert tokens to WSOL
				const sellInstruction = await sell_pump_amm(pumpSwapBaseMint, keypair, Number(tokenBalance.value.uiAmountString), 0);

				if (sellInstruction) {
					instructionsForChunk.push(...sellInstruction);
				}

				// Burn token account
				const baseMintTokenProgram = await getTokenProgramId(pumpSwapBaseMint);
				let baseTokenBurnInstruction = await burnAccount(wallet, keypair, connection, tokenAcc, baseMintTokenProgram);
				instructionsForChunk.push(...baseTokenBurnInstruction);
			}

			if (wsolAccountExists) {
				// Burn WSOL account
				let wsolBurnInstruction = await burnAccount(wallet, keypair, connection, wsolAcc, spl.TOKEN_PROGRAM_ID);
				instructionsForChunk.push(...wsolBurnInstruction);
			}

			// Drain leftover SOL
			const balance = await connection.getBalance(keypair.publicKey);
			const feeEstimate = 10000;
			const transferAmount = balance - feeEstimate > 0 ? balance - feeEstimate : 0;

			const drainBalanceIxn = SystemProgram.transfer({
				fromPubkey: keypair.publicKey,
				toPubkey: wallet.publicKey,
				lamports: transferAmount,
			});
			instructionsForChunk.push(drainBalanceIxn);

			// Jito tip
			const tipSwapIxn = SystemProgram.transfer({
				fromPubkey: wallet.publicKey,
				toPubkey: tipAcct,
				lamports: BigInt(jitoTip),
			});
			instructionsForChunk.push(tipSwapIxn);

			// Create and sign transaction
			const message = new TransactionMessage({
				payerKey: keypair.publicKey,
				recentBlockhash: block,
				instructions: instructionsForChunk,
			}).compileToV0Message();

			const versionedTx = new VersionedTransaction(message);
			versionedTx.sign([wallet, keypair]);

			BundledTxns.push(versionedTx);
		}
		// Handle CPMM or non-CPMM cases (existing code)
		else {
			const WSOLataKeypair = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, keypair.publicKey);

			if (await checkTokenAccountExists(WSOLataKeypair)) {
				const instructionsForChunk: TransactionInstruction[] = [];

				if (!isCPMM && keys) {
					let useQuoteMint = true;
					if (keys.quoteMint.toBase58() === "So11111111111111111111111111111111111111112") {
						useQuoteMint = false;
					}
					const baseataKeypair = useQuoteMint
						? await spl.getAssociatedTokenAddress(new PublicKey(keys.quoteMint), keypair.publicKey)
						: await spl.getAssociatedTokenAddress(new PublicKey(keys.baseMint), keypair.publicKey);

					// SELL => reverse = true
					const { sellIxs } = makeSwap(keys, WSOLataKeypair, baseataKeypair, true, keypair);
					instructionsForChunk.push(...sellIxs);

					const baseMintTokenProgram = useQuoteMint ? await getTokenProgramId(keys.quoteMint) : await getTokenProgramId(keys.baseMint);
					let wsolBurnInstruction = await burnAccount(wallet, keypair, connection, WSOLataKeypair, spl.TOKEN_PROGRAM_ID);
					instructionsForChunk.push(...wsolBurnInstruction);
					let baseTokenBurnInstruction = await burnAccount(wallet, keypair, connection, baseataKeypair, baseMintTokenProgram);
					instructionsForChunk.push(...baseTokenBurnInstruction);
				} else if (isCPMM && poolInfo) {
					let baseMint: PublicKey, quoteMint: PublicKey;
					if (poolInfo.mintA.equals(WSOLMint)) {
						baseMint = poolInfo.mintA;
						quoteMint = poolInfo.mintB;
					} else if (poolInfo.mintB.equals(WSOLMint)) {
						baseMint = poolInfo.mintB;
						quoteMint = poolInfo.mintA;
					} else {
						baseMint = poolInfo.mintA;
						quoteMint = poolInfo.mintB;
					}

					const userTokenMint = baseMint.equals(WSOLMint) ? quoteMint : baseMint;
					const otherTokenATA = await spl.getAssociatedTokenAddress(userTokenMint, keypair.publicKey);

					const { swapIxs } = await makeCPMMSwap(
						connection,
						poolId,
						poolInfo,
						spl.NATIVE_MINT,
						WSOLataKeypair, // wSol
						userTokenMint, // which token the user is selling
						otherTokenATA, // user's other token ATA
						keypair,
						"sell" // direction
					);
					instructionsForChunk.push(...swapIxs);

					const baseMintTokenProgram = await getTokenProgramId(userTokenMint);
					let wsolBurnInstruction = await burnAccount(wallet, keypair, connection, WSOLataKeypair, spl.TOKEN_PROGRAM_ID);
					instructionsForChunk.push(...wsolBurnInstruction);
					let baseTokenBurnInstruction = await burnAccount(wallet, keypair, connection, otherTokenATA, baseMintTokenProgram);
					instructionsForChunk.push(...baseTokenBurnInstruction);
				}

				// Transfer leftover SOL
				const balance = await connection.getBalance(keypair.publicKey);
				const feeEstimate = 10000;
				const transferAmount = balance - feeEstimate > 0 ? balance - feeEstimate : 0;

				const drainBalanceIxn = SystemProgram.transfer({
					fromPubkey: keypair.publicKey,
					toPubkey: wallet.publicKey,
					lamports: transferAmount,
				});
				instructionsForChunk.push(drainBalanceIxn);

				// Jito tip
				const tipSwapIxn = SystemProgram.transfer({
					fromPubkey: wallet.publicKey,
					toPubkey: tipAcct,
					lamports: BigInt(jitoTip),
				});
				instructionsForChunk.push(tipSwapIxn);

				const message = new TransactionMessage({
					payerKey: keypair.publicKey,
					recentBlockhash: block,
					instructions: instructionsForChunk,
				}).compileToV0Message();

				const versionedTx = new VersionedTransaction(message);
				versionedTx.sign([wallet, keypair]);

				BundledTxns.push(versionedTx);
			} else {
				console.log(chalk.yellow(`Skipping keypair with zero balance or no token account:`), keypair.publicKey.toString());
				deleteKeypairFile(keypair, keypairsPath);
			}
		}

		// Send in batches of 5 or at the end
		if (BundledTxns.length === 5 || i === keypairs.length - 1) {
			try {
				console.log(chalk.red("Sending bundled sell transactions..."));
				await sendBundleWithRetry(BundledTxns);
				BundledTxns.length = 0;
			} catch (error) {
				console.error("Error during sendBundleWithRetry:", error);
			}
		}
	}
}

/**
 * Closes a particular account (by index) for a Pair ID, using CPMM, Non-CPMM, or PumpSwap approach.
 */
export async function closeParticularAcc(walletNumber: number) {
	if (walletNumber <= 0) {
		return console.log(chalk.red("Wallet number should be greater than 0"));
	}
	console.clear();
	console.log(chalk.green("\n==================== Close Particular Account ===================="));
	console.log(chalk.yellow("Follow the instructions below to close a particular account.\n"));

	const marketID = prompt(chalk.cyan("Enter your Pair ID or Token Mint: "));
	const jitoTipAmtInput = prompt(chalk.cyan("Jito tip in Sol (Ex. 0.001): "));
	const jitoTipAmt = parseFloat(jitoTipAmtInput) * LAMPORTS_PER_SOL;

	if (jitoTipAmtInput) {
		const tipValue = parseFloat(jitoTipAmtInput);
		if (tipValue >= 0.1) {
			console.log(chalk.red("Error: Tip value is too high. Please enter a value less than or equal to 0.1."));
			process.exit(0);
		}
	} else {
		console.log(chalk.red("Error: Invalid input. Please enter a valid number."));
		process.exit(0);
	}

	// Try to interpret marketID as both a pool ID and a token mint
	const marketIdPubkey = new PublicKey(marketID);

	// First check if it's a PumpSwap pool
	let isPumpSwap = false;
	let pumpSwapBaseMint: PublicKey | null = null;

	try {
		const pSwap = new PumpSwapSDK();
		// If marketID is a token mint, try to get the pool
		const pumpSwapPool = await pSwap.getPumpSwapPool(marketIdPubkey);
		if (pumpSwapPool) {
			isPumpSwap = true;
			pumpSwapBaseMint = marketIdPubkey;
			console.log(chalk.green(`Detected PumpSwap pool for token: ${marketID}`));
		}
	} catch {
		// Not a PumpSwap pool or not a valid mint
		isPumpSwap = false;
	}

	// If not PumpSwap, check if CPMM
	let poolInfo: CpmmRpcData | null = null;
	let isCPMM = false;
	let keys = null;
	const poolId = new PublicKey(marketID);

	if (!isPumpSwap) {
		const dummyOwner = Keypair.generate();
		const raydium = await Raydium.load({
			owner: dummyOwner,
			connection,
			cluster: "mainnet",
			disableFeatureCheck: true,
			disableLoadToken: true,
			blockhashCommitment: "finalized",
		});

		try {
			poolInfo = await raydium.cpmm.getRpcPoolInfo(marketID);
			isCPMM = true;
		} catch {
			isCPMM = false;
		}

		if (!isCPMM) {
			try {
				const poolPrompt = await formatAmmKeysById(marketID);
				const derivedMarketId = poolPrompt.marketId;
				keys = await derivePoolKeys(new PublicKey(derivedMarketId));

				if (keys === null) {
					console.log(chalk.red("Error fetching pool keys"));
					process.exit(0);
				}
			} catch (error) {
				console.log(chalk.red(`Could not identify market type for ID: ${marketID}`));
				process.exit(0);
			}
		}
	}

	// Get the keypair file
	const files = fs.readdirSync(path.join(keypairsDir, marketID));
	if (walletNumber > files.length) {
		console.log(chalk.red("Invalid wallet number: out of range."));
		return;
	}

	const file = files[walletNumber - 1];
	const filePath = path.join(keypairsDir, marketID, file);
	const fileData = JSON.parse(fs.readFileSync(filePath, "utf8"));
	if (fileData && files.length > 0) {
		const keypair = Keypair.fromSecretKey(new Uint8Array(fileData));
		let txsSigned: VersionedTransaction[] = [];
		let { blockhash } = await retryOperation(() => connection.getLatestBlockhash());

		console.log(chalk.blue(`Processing keypair: ${keypair.publicKey.toString()}`));

		// Initialize instructions array outside the conditionals
		const instructionsForChunk: TransactionInstruction[] = [];
		let shouldContinue = false; // Default to not continue unless we find tokens

		// Handle PumpSwap
		if (isPumpSwap && pumpSwapBaseMint) {
			console.log(chalk.blue("Processing PumpSwap token..."));
			const tokenAcc = await spl.getAssociatedTokenAddress(pumpSwapBaseMint, keypair.publicKey);
			const wsolAcc = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, keypair.publicKey);

			// Verify token account exists and has balance
			let tokenAccountExists = false;
			let tokenAmount = 0;
			let tokenAmountString = "0";

			try {
				const accountInfo = await connection.getAccountInfo(tokenAcc);
				if (accountInfo !== null) {
					const balanceResponse = await connection.getTokenAccountBalance(tokenAcc);
					tokenAmount = balanceResponse.value.uiAmount || 0;
					tokenAmountString = balanceResponse.value.uiAmountString || "0";
					tokenAccountExists = accountInfo !== null && tokenAmount > 0;

					console.log(chalk.blue(`Token account exists: ${tokenAccountExists}`));
					console.log(chalk.blue(`Token balance: ${tokenAmountString} (${tokenAmount})`));
				} else {
					console.log(chalk.yellow("Token account doesn't exist"));
				}
			} catch (error) {
				console.log(chalk.red(`Error checking token account: ${error}`));
			}

			const wsolAccountExists = await checkTokenAccountExists(wsolAcc);

			// Check if the keypair account has any SOL balance
			const solBalance = await connection.getBalance(keypair.publicKey);
			const minBalanceForRent = 10000; // Minimum balance to be worth transferring

			// Only proceed if either token account exists with balance or WSOL account exists or SOL balance > minimum
			if (tokenAccountExists || wsolAccountExists || solBalance > minBalanceForRent) {
				shouldContinue = true;

				if (solBalance > minBalanceForRent) {
					console.log(chalk.green(`Account has ${solBalance / LAMPORTS_PER_SOL} SOL, will transfer to main wallet`));
				}

				if (tokenAccountExists) {
					// Sell instructions
					const sellInstruction = await sell_pump_amm(pumpSwapBaseMint, keypair, Number(tokenAmountString), 0);

					if (sellInstruction) {
						instructionsForChunk.push(...sellInstruction);
						console.log(chalk.green(`Added PumpSwap sell instructions for ${tokenAmountString} tokens`));
					} else {
						console.log(chalk.yellow("Failed to create sell instructions"));
					}

					// Burn token account
					const baseMintTokenProgram = await getTokenProgramId(pumpSwapBaseMint);
					let baseTokenBurnInstruction = await burnAccount(wallet, keypair, connection, tokenAcc, baseMintTokenProgram);
					instructionsForChunk.push(...baseTokenBurnInstruction);
				} else {
					console.log(chalk.yellow(`No token balance found for ${pumpSwapBaseMint.toString()}`));
				}

				if (wsolAccountExists) {
					// Burn WSOL account
					let wsolBurnInstruction = await burnAccount(wallet, keypair, connection, wsolAcc, spl.TOKEN_PROGRAM_ID);
					instructionsForChunk.push(...wsolBurnInstruction);
				}
			} else {
				console.log(chalk.yellow("No token, WSOL, or significant SOL balance found. Skipping transaction."));
				shouldContinue = false;
			}
		}
		// Handle CPMM or standard Raydium pools
		else {
			const WSOLataKeypair = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, keypair.publicKey);

			if (await checkTokenAccountExists(WSOLataKeypair)) {
				if (!isCPMM && keys) {
					let useQuoteMint = true;
					if (keys.quoteMint.toBase58() === "So11111111111111111111111111111111111111112") {
						useQuoteMint = false;
					}
					const baseataKeypair = useQuoteMint
						? await spl.getAssociatedTokenAddress(new PublicKey(keys.quoteMint), keypair.publicKey)
						: await spl.getAssociatedTokenAddress(new PublicKey(keys.baseMint), keypair.publicKey);

					// SELL => reverse = true
					const { sellIxs } = makeSwap(keys, WSOLataKeypair, baseataKeypair, true, keypair);
					instructionsForChunk.push(...sellIxs);

					const baseMintTokenProgram = useQuoteMint ? await getTokenProgramId(keys.quoteMint) : await getTokenProgramId(keys.baseMint);
					let wsolBurnInstruction = await burnAccount(wallet, keypair, connection, WSOLataKeypair, spl.TOKEN_PROGRAM_ID);
					instructionsForChunk.push(...wsolBurnInstruction);
					let baseTokenBurnInstruction = await burnAccount(wallet, keypair, connection, baseataKeypair, baseMintTokenProgram);
					instructionsForChunk.push(...baseTokenBurnInstruction);
				} else if (isCPMM && poolInfo) {
					let baseMint: PublicKey, quoteMint: PublicKey;
					if (poolInfo.mintA.equals(WSOLMint)) {
						baseMint = poolInfo.mintA;
						quoteMint = poolInfo.mintB;
					} else if (poolInfo.mintB.equals(WSOLMint)) {
						baseMint = poolInfo.mintB;
						quoteMint = poolInfo.mintA;
					} else {
						baseMint = poolInfo.mintA;
						quoteMint = poolInfo.mintB;
					}

					const userTokenMint = baseMint.equals(WSOLMint) ? quoteMint : baseMint;
					const otherTokenATA = await spl.getAssociatedTokenAddress(userTokenMint, keypair.publicKey);

					// SELL
					const { swapIxs } = await makeCPMMSwap(connection, poolId, poolInfo, spl.NATIVE_MINT, WSOLataKeypair, userTokenMint, otherTokenATA, keypair, "sell");
					instructionsForChunk.push(...swapIxs);

					const baseMintTokenProgram = await getTokenProgramId(userTokenMint);
					let wsolBurnInstruction = await burnAccount(wallet, keypair, connection, WSOLataKeypair, spl.TOKEN_PROGRAM_ID);
					instructionsForChunk.push(...wsolBurnInstruction);
					let baseTokenBurnInstruction = await burnAccount(wallet, keypair, connection, otherTokenATA, baseMintTokenProgram);
					instructionsForChunk.push(...baseTokenBurnInstruction);
				} else {
					console.log(chalk.red("Could not identify pool type."));
					shouldContinue = false;
					process.exit(0);
				}
			} else {
				console.log(chalk.yellow(`Skipping keypair with zero balance: ${keypair.publicKey.toString()}`));
				deleteKeypairFile(keypair, marketID);
				shouldContinue = false;
				return;
			}
		}

		// Only continue if previous steps worked
		if (shouldContinue) {
			// Drain leftover SOL
			const balance = await connection.getBalance(keypair.publicKey);
			const feeEstimate = 10000;
			const transferAmount = balance - feeEstimate > 0 ? balance - feeEstimate : 0;

			const drainBalanceIxn = SystemProgram.transfer({
				fromPubkey: keypair.publicKey,
				toPubkey: wallet.publicKey,
				lamports: transferAmount,
			});
			instructionsForChunk.push(drainBalanceIxn);

			// Tip
			const tipSwapIxn = SystemProgram.transfer({
				fromPubkey: wallet.publicKey,
				toPubkey: tipAcct,
				lamports: BigInt(jitoTipAmt),
			});
			instructionsForChunk.push(tipSwapIxn);

			const message = new TransactionMessage({
				payerKey: keypair.publicKey,
				recentBlockhash: blockhash,
				instructions: instructionsForChunk,
			}).compileToV0Message();

			const versionedTx = new VersionedTransaction(message);
			versionedTx.sign([wallet, keypair]);

			txsSigned.push(versionedTx);

			// (Optional) Simulate for debug
			for (const tx of txsSigned) {
				try {
					const simulationResult = await connection.simulateTransaction(tx, { commitment: "processed" });
					if (simulationResult.value.err) {
						console.error("Simulation error for transaction:", simulationResult.value.err);
						if (simulationResult.value.logs) {
							console.log("Simulation logs:");
							simulationResult.value.logs.forEach((log: any) => console.log(log));
						}
					} else {
						console.log("Simulation success for transaction. Logs:");
						if (simulationResult.value.logs) {
							simulationResult.value.logs.forEach((log: any) => console.log(log));
						}
					}
				} catch (error) {
					console.error("Error during simulation:", error);
				}
			}

			// Now send the transaction
			await sendBundle(txsSigned);
		}

		console.log(chalk.green("All transactions processed for the specified keypair."));
		await pause();
	}
}
/**
 * Utility to send a batch of VersionedTx with minimal delay/retry logic.
 */
export async function sendBundleWithRetry(txsSigned: VersionedTransaction[]) {
	await delay(100);
	await sendBundle(txsSigned);
}

/**
 * Simple delay helper.
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks if an SPL token account exists (non-null).
 */
export async function checkTokenAccountExists(accountPublicKeyString: PublicKey): Promise<boolean> {
	try {
		const accountPublicKey = new PublicKey(accountPublicKeyString);
		const accountInfo = await connection.getAccountInfo(accountPublicKey);

		if (accountInfo === null) {
			if (DEBUG) {
				console.log(chalk.yellow(`Token account ${accountPublicKeyString} does not exist.`));
			}
			return false;
		} else {
			console.log(chalk.green(`Selling from existing token account: ${accountPublicKeyString}`));
			return true;
		}
	} catch (error) {
		console.error(chalk.red(`Error checking account: ${error}`));
		return false;
	}
}

/**
 * Delete a keypair JSON if older than a minute, backing it up in /backup.
 */
export async function deleteKeypairFile(keypair: Keypair, marketOrDir: string) {
	let resolvedDir: string;
	if (marketOrDir.includes("keypairs")) {
		resolvedDir = marketOrDir;
	} else {
		resolvedDir = path.join(keypairsDir, marketOrDir);
	}

	const identifier = keypair.publicKey.toString();
	const filename = `keypair-${identifier}.json`;
	const filePath = path.join(resolvedDir, filename);
	const backupDir = path.join(path.dirname(path.dirname(resolvedDir)), "backup", path.basename(resolvedDir));

	if (!fs.existsSync(filePath)) {
		console.log(`File does not exist: ${filePath}`);
		return;
	}

	const stats = fs.statSync(filePath);
	const creationTime = new Date(stats.birthtime).getTime();
	const currentTime = Date.now();

	if (currentTime - creationTime < 80000) {
		console.log(`Skipping deletion as file is not older than 1 minute: ${filename}`);
		return;
	}

	const transactionCount = await getTransactionCount(keypair.publicKey);
	if (transactionCount === 1) {
		console.log(`Transaction count is 1 (which means it didn't sell) for keypair: ${identifier}. Total TXs: ${transactionCount}`);
		return;
	}

	try {
		if (!fs.existsSync(backupDir)) {
			fs.mkdirSync(backupDir, { recursive: true });
		}
		const backupFilePath = path.join(backupDir, filename);
		fs.copyFileSync(filePath, backupFilePath);

		fs.unlinkSync(filePath);
		if (DEBUG) {
			console.log(`Deleted file for keypair with zero balance: ${filename}`);
		}
		const files = fs.readdirSync(resolvedDir);
		if (files.length === 0) {
			fs.rmdirSync(resolvedDir);
			console.log(`Deleted empty pair folder: ${resolvedDir}`);
		}
	} catch (err) {
		console.error(`Error backing up or deleting file: ${filename}`, err);
	}
}

/**
 * Return total transaction count for a given address.
 */
async function getTransactionCount(publicKey: PublicKey): Promise<number> {
	try {
		const confirmedSignatures = await connection.getSignaturesForAddress(publicKey);
		return confirmedSignatures.length;
	} catch (err) {
		console.error(`Error fetching transaction count for ${publicKey.toString()}`, err);
		return 0;
	}
}

/**
 * Loads all .json keypairs from a directory.
 */
function loadKeypairs(dirPath: string) {
	const keypairs: Keypair[] = [];
	const files = fs.readdirSync(dirPath);

	files.forEach((file) => {
		if (file.endsWith(".json")) {
			const filePath = path.join(dirPath, file);
			const fileData = JSON.parse(fs.readFileSync(filePath, "utf8"));
			const keypair = Keypair.fromSecretKey(new Uint8Array(fileData));
			keypairs.push(keypair);
		}
	});
	return keypairs;
}

/**
 * True if any .json keypair files exist in the directory.
 */
function checkKeypairsExist(dirPath: string) {
	try {
		if (!fs.existsSync(dirPath)) {
			return false;
		}
		const files = fs.readdirSync(dirPath);
		const keypairFiles = files.filter((file) => file.endsWith(".json"));
		return keypairFiles.length > 0;
	} catch (err) {
		console.error("Error accessing the keypairs directory:", err);
		return false;
	}
}

/**
 *
 * @param mint PublicKey
 * @returns Token program ID
 */
async function getTokenProgramId(mint: PublicKey): Promise<PublicKey> {
	try {
		// First check if it's a Token-2022 account
		try {
			const accountInfo = await connection.getAccountInfo(mint);
			if (accountInfo) {
				// Check the owner of the account
				if (accountInfo.owner.equals(spl.TOKEN_2022_PROGRAM_ID)) {
					console.log(`Mint ${mint.toBase58()} is a Token-2022 token`);
					return spl.TOKEN_2022_PROGRAM_ID;
				}
			}
		} catch (err: any) {
			// If there's an error, default to classic SPL Token
			console.log(`Error checking Token-2022 status: ${err.message}`);
		}

		// Default to classic SPL Token
		console.log(`Mint ${mint.toBase58()} is a classic SPL token`);
		return spl.TOKEN_PROGRAM_ID;
	} catch (error: any) {
		console.error(`Error determining token program ID: ${error.message}`);
		// Default to classic SPL Token
		return spl.TOKEN_PROGRAM_ID;
	}
}

export const sell_pump_amm = async (base_mint: PublicKey, keypair: Keypair, tokenAmount: Number, wsolAmount: Number) => {
	try {
		//   const payer = Keypair.fromSecretKey(
		// 	bs58.decode(process.env.WALLET_PRIVATEKEY || "")
		//   );
		let NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
		const pSwap = new PumpSwapSDK();
		console.log("base_mint", base_mint.toString());

		const pool = await pSwap.getPumpSwapPool(base_mint);

		if (!pool) {
			return null;
		}

		const quote_amt = new BN((wsolAmount as number) * LAMPORTS_PER_SOL);
		const base_amt = new BN((tokenAmount as number) * 10 ** 6);

		const sellIxs = await pSwap.getSellInstruction(base_amt, quote_amt, {
			pool,
			baseMint: base_mint,
			quoteMint: NATIVE_MINT,
			baseTokenProgram: spl.TOKEN_PROGRAM_ID,
			quoteTokenProgram: spl.TOKEN_PROGRAM_ID,
			user: keypair.publicKey,
		});
		return [sellIxs];
	} catch (error) {
		console.log("error:", error);
		return null;
	}
};

export const closePumpSwapAcc = async (keypairs: Keypair[], baseMint: PublicKey) => {
	for (let index = 0; index < keypairs.length; index++) {
		const instructionsForChunk: TransactionInstruction[] = [];
		const keypair = keypairs[index];
		const tokenAcc = spl.getAssociatedTokenAddressSync(baseMint, keypair.publicKey);
		const wsolAcc = spl.getAssociatedTokenAddressSync(spl.NATIVE_MINT, keypair.publicKey);
		const accinfo = await connection.getAccountInfo(tokenAcc);
		const wsolaccinfo = await connection.getAccountInfo(wsolAcc);

		const tokenBalance = await connection.getTokenAccountBalance(tokenAcc);

		const sellInstruction = await sell_pump_amm(baseMint, keypair, Number(tokenBalance.value.uiAmountString), 0);
		if (!sellInstruction) {
			return;
		}
		instructionsForChunk.push(...sellInstruction);

		if (accinfo) {
			// Get the token program ID for the non-WSOL token
			const baseMintTokenProgram = await getTokenProgramId(baseMint);
			let baseTokenBurnInstruction = await burnAccount(wallet, keypair, connection, tokenAcc, baseMintTokenProgram);
			instructionsForChunk.push(...baseTokenBurnInstruction);
		}
		if (wsolaccinfo) {
			let baseTokenBurnInstruction = await burnAccount(wallet, keypair, connection, wsolAcc, spl.TOKEN_PROGRAM_ID);
			instructionsForChunk.push(...baseTokenBurnInstruction);
		}

		// const balance = await connection.getBalance(keypair.publicKey);
		// const feeEstimate = 10000;
		// const transferAmount = balance - feeEstimate > 0 ? balance - feeEstimate : 0;
		// if (transferAmount > 0) {
		//   const drainBalanceIxn = SystemProgram.transfer({
		//     fromPubkey: keypair.publicKey,
		//     toPubkey: wallet.publicKey,
		//     lamports: transferAmount,
		//   });
		//   instructionsForChunk.push(drainBalanceIxn);
		// }

		const addressesMain: PublicKey[] = [];
		instructionsForChunk.forEach((ixn) => {
			ixn.keys.forEach((key) => {
				addressesMain.push(key.pubkey);
			});
		});
		const lookupTablesMain = lookupTableProvider.computeIdealLookupTablesForAddresses(addressesMain);
		let blockhash = (await retryOperation(() => connection.getLatestBlockhash())).blockhash;
		const message = new TransactionMessage({
			payerKey: keypair.publicKey,
			recentBlockhash: blockhash,
			instructions: instructionsForChunk,
		}).compileToV0Message(lookupTablesMain);

		const versionedTx = new VersionedTransaction(message);
		versionedTx.sign([keypair]);

		try {
			const swapsim = await provider.connection.simulateTransaction(versionedTx, { sigVerify: true });
			const swapId = await provider.connection.sendTransaction(versionedTx);
			const lockPoolConfirm = await provider.connection.confirmTransaction(swapId);
		} catch (e) {
			console.log(e, "error with versionedTx");
			process.exit(0);
		}
	}
};
