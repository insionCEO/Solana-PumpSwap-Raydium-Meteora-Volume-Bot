import {
	createBurnCheckedInstruction,
	createCloseAccountInstruction,
	harvestWithheldTokensToMint,
	getAssociatedTokenAddressSync,
	createAssociatedTokenAccountIdempotentInstruction,
	createSyncNativeInstruction,
	NATIVE_MINT,
	TOKEN_PROGRAM_ID,
	TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { wallet, connection, tipAcct } from "../config";

import {
	TransactionMessage,
	Connection,
	PublicKey,
	Keypair,
	VersionedTransaction,
	TransactionInstruction,
	clusterApiUrl,
	Transaction,
	LAMPORTS_PER_SOL,
	SystemProgram,
	sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import BN from "bn.js";
import { PumpSwapSDK } from "./pump_swap_sdk";

export const burnAccount = async (wallet: Keypair, keypair: Keypair, connection: Connection, ata: PublicKey, tokenprogram: PublicKey) => {
	const instructions: Array<TransactionInstruction> = [];

	const ataInfo = // @ts-ignore
		(await connection.getParsedAccountInfo(ata)).value?.data.parsed.info;
	// console.log("ata info", ataInfo);

	if (tokenprogram === TOKEN_2022_PROGRAM_ID) {
		const sig = await harvestWithheldTokensToMint(connection, keypair, new PublicKey(ataInfo.mint), [ata], undefined, tokenprogram);
	}
	const solanaBalance = await connection.getBalance(keypair.publicKey);
	// console.log("token amount---------", ataInfo.tokenAmount.uiAmount);
	// console.log("sol balance---------", solanaBalance);

	// if (ataInfo.tokenAmount.uiAmount != 0) {
	//   const mint = ataInfo.mint;
	//   const burnInx = createBurnCheckedInstruction(
	//     ata,
	//     new PublicKey(mint),
	//     keypair.publicKey,
	//     ataInfo.tokenAmount.amount,
	//     ataInfo.tokenAmount.decimals,
	//     [],
	//     tokenprogram
	//   );
	//   instructions.push(burnInx);
	// }

	const closeAtaInx = createCloseAccountInstruction(
		ata, // token account which you want to close
		wallet.publicKey, // destination
		keypair.publicKey, // owner of token account
		[],
		tokenprogram
	);
	instructions.push(closeAtaInx);
	return instructions;
	// for (let i = 0; i < instructions.length; i += 20) {
	//   const instructionsList = instructions.slice(
	//     i,
	//     Math.min(i + 20, instructions.length)
	//   );
	//   if (instructionsList.length == 0) break;
	//   const blockhash = await connection
	//     .getLatestBlockhash()
	//     .then((res) => res.blockhash);
	//   const messageV0 = new TransactionMessage({
	//     payerKey: keypair.publicKey,
	//     recentBlockhash: blockhash,
	//     instructions: [
	//       // ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 }),
	//       ...instructionsList,
	//     ],
	//   }).compileToV0Message();

	//   const vtx = new VersionedTransaction(messageV0);
	//   vtx.sign([wallet, keypair]);

	//   const sim = await connection.simulateTransaction(vtx, {
	//     sigVerify: true,
	//   });
	//   console.log(sim);
	//   try {
	//     if (!sim.value.err) {
	//       const sig = await connection.sendTransaction(vtx);
	//       const closeConfirm = await connection.confirmTransaction(sig);
	//       console.log("sig", sig);
	//     } else console.error("simulation error");
	//   } catch (e) {
	//     console.error(e);
	//   }
	// }
};