// Use: npm run wallet:new   (apne LOCAL computer par chalao, server par nahi)
// Naya, alag "hot wallet" banata hai sirf is automation ke liye. Mnemonic sirf EK baar dikhta hai.
// Isme sirf utne paise rakho jitne kuch orders ke liye chahiye. Apna main wallet KABHI is kaam ke liye mat do.
import { TonWallet } from "@mystars-tg/faas-wallet";

const { wallet, mnemonic } = await TonWallet.generate();
console.log("Fund this address (GRAM, aur USDT agar usdt_ton use kar rahe ho):");
console.log("  ", wallet.address);
console.log("\nMnemonic (24 words) - password manager mein save karo, kisi ko mat bhejo, chat mein paste mat karo:");
console.log("  ", Array.isArray(mnemonic) ? mnemonic.join(" ") : mnemonic);
console.log("\nIse Railway Variables mein WALLET_MNEMONIC naam se daalo (space-separated).");
