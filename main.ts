import {randomTestKey} from "ton/dist/utils/randomTestKey";
import {compileFunc} from '@ton-community/func-js';
import {Blockchain} from '@ton-community/sandbox';
import {readFileSync, writeFileSync} from 'fs';
import {Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, Slice, toNano, TupleBuilder} from 'ton';
import { sign } from "ton-crypto";

(async () => {
    let coordinatorResult = await compileFunc({
        targets: ['exotic.fif.fc', 'stdlib.fc', 'coordinator.fc'],
        sources: (path) => readFileSync(__dirname + '/src/' + path).toString()
    });
    if (coordinatorResult.status === 'error') {
        console.error(coordinatorResult.message)
        return;
    }
    let coordinatorCode = Cell.fromBoc(Buffer.from(coordinatorResult.codeBoc, "base64"))[0];

    writeFileSync(__dirname + '/coordinator.boc.b64', coordinatorResult.codeBoc);
    
    class CoordinatorUnit implements Contract {
        constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

        static createFromOwnerAndKey(owner: Address, publicKeyEcvrf: bigint, publicKeyReplay: Buffer) {
            const data = beginCell()
                .storeUint(0, 1 + 64 + 8 + 16)
                .storeAddress(owner)
                .storeUint(publicKeyEcvrf, 256)
                .storeBuffer(publicKeyReplay)
                .storeUint(0, 32)
                .endCell();
            const init = {code: coordinatorCode, data};
            return new CoordinatorUnit(contractAddress(0, init), init);
        }

        async sendSubscribeRandom(provider: ContractProvider, via: Sender, value: bigint, consumer?: Address) {
            consumer = consumer ?? via.address!!;

            await provider.internal(via, {
                value,
                body: beginCell()
                    .storeUint(0xAB4C4859, 32)
                    .storeAddress(consumer)
                    .endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });
        }

        async getAlpha(provider: ContractProvider): Promise<Slice> {
            const result = await provider.get('get_alpha', []);
            const alpha = result.stack.pop();
            if (alpha.type != 'slice') throw new Error('get-method returned invalid value');
            return alpha.cell.beginParse();
        }

        async sendProvideRandomness(provider: ContractProvider, pi: Slice, secretReplay: Buffer) {
            const contractState = (await provider.getState()).state;
            if (contractState.type != 'active') throw new Error('invalid contract state');
            const hashToSign = Cell.fromBoc(contractState.data!!)[0].hash();
            const signature = beginCell().storeBuffer(sign(hashToSign, secretReplay)).endCell();
            await provider.external(beginCell().storeSlice(pi).storeRef(signature).endCell());
        }

        async getBalance(provider: ContractProvider): Promise<Number> {
            return Number((await provider.getState()).balance) / 1e9;
        }

        async getCalcPiFromAlpha(provider: ContractProvider, secret: bigint, alpha: Slice): Promise<Slice> {
            let args = new TupleBuilder();
            args.writeNumber(secret);
            args.writeSlice(alpha);
            const result = await provider.get('ecvrf::rist255::with_secret::prove', args.build());
            const pi = result.stack.pop();
            if (pi.type != 'slice') throw new Error('get-method returned invalid value');
            return pi.cell.beginParse();
        }

        async sendDeploy(provider: ContractProvider, via: Sender) {
            await provider.internal(via, {
                value: toNano('1.0'),
                body: beginCell().endCell(),
                bounce: false
            });
        }

        async getPublicKey(provider: ContractProvider, secret: bigint): Promise<bigint> {
            let args = new TupleBuilder();
            args.writeNumber(secret);
            return (await provider.get('rist255::get_public_key', args.build())).stack.readBigNumber();
        }

        async sendWithdraw(provider: ContractProvider, via: Sender) {
            await provider.internal(via, {
                value: toNano('0.1'),
                body: beginCell().storeUint(0xCB03BFAF, 32).endCell(),
                bounce: true
            });
        }

        async getUnfulfilled(provider: ContractProvider): Promise<number> {
            return (await provider.get('get_unfulfilled', [])).stack.readNumber();
        }
    }

    const blockchain = await Blockchain.create({config: 'slim'});
    /*
    function walk(cell: Cell): Cell {
        if (cell.bits.toString().trim() == 'D1000000000000006400000000000186A0DE0000000003E8000000000000000F424000000000000F4240000000000000271000000000009896800000000005F5E100000000003B9ACA00') {
            console.log('[external gas credit 10000->20000: patch successful]');
            return beginCell()
                .storeBuffer(Buffer.from('D1000000000000006400000000000186A0DE0000000003E8000000000000000F424000000000000F424000000000000032C800000000009896800000000005F5E100000000003B9ACA00', 'hex'))
                .endCell();
        }
        let rebuilt = beginCell().storeBits(cell.bits);
        for (let ref of cell.refs) {
            rebuilt.storeRef(walk(ref));
        }
        return rebuilt.endCell();
    }
    blockchain.setConfig(walk(blockchain.config));
    */

    const createOpenCoordinator = (owner: Address, publicEcvrf: bigint, publicReplay: Buffer) =>
        blockchain.openContract(CoordinatorUnit.createFromOwnerAndKey(owner, publicEcvrf, publicReplay));

    const deployer = await blockchain.treasury('deployer');
    let keyReplay = randomTestKey('ecvrf-coordinator');

    const secretEcvrf = 123456n;

    const invalidEcvrf = createOpenCoordinator(deployer.address, 0n, keyReplay.publicKey);
    await invalidEcvrf.sendDeploy(deployer.getSender());

    const publicKey = await invalidEcvrf.getPublicKey(secretEcvrf);
    const ecvrf = createOpenCoordinator(deployer.address, publicKey, keyReplay.publicKey);
    await ecvrf.sendDeploy(deployer.getSender());

    console.log('Loaded secret:', secretEcvrf);
    const alpha = await ecvrf.getAlpha();
    console.log('Loaded alpha from contract:', alpha);
    const pi = await ecvrf.getCalcPiFromAlpha(secretEcvrf, alpha);
    console.log('Calculated pi:', pi);
    await ecvrf.sendProvideRandomness(pi, keyReplay.secretKey);
    console.log('Sent pi to blockchain');


    await ecvrf.sendWithdraw(deployer.getSender());
    console.log();
    console.log(await ecvrf.getBalance());

    await ecvrf.sendSubscribeRandom(deployer.getSender(), 610000000n);

    console.log(await ecvrf.getBalance(), await ecvrf.getUnfulfilled());
    console.time('rnd-loop');
    for (let i = 0; i < 12; i++) {
        await new Promise((resolve) => setTimeout(resolve, 990));
        const alpha = await ecvrf.getAlpha();
        const pi = await ecvrf.getCalcPiFromAlpha(secretEcvrf, alpha);
        await ecvrf.sendProvideRandomness(pi, keyReplay.secretKey);
        console.timeLog('rnd-loop', i, await ecvrf.getBalance(), await ecvrf.getUnfulfilled());
    }
    console.timeEnd('rnd-loop');
    await ecvrf.sendWithdraw(deployer.getSender());
    console.log(await ecvrf.getBalance());
})();

