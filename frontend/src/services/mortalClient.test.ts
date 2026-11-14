import { describe, expect, it } from 'vitest';
import { createMortalClient } from './mortalClient';
import type { MortalWorkerLike } from './mortalClient';
import type {
  MortalRequest,
  MortalResponse,
} from '../workers/mortalProtocol';

/** A worker stand-in that records messages instead of evaluating anything. */
class FakeWorker implements MortalWorkerLike {
  onmessage: ((event: MessageEvent<MortalResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: MortalRequest[] = [];
  transfers: Array<Transferable[] | undefined> = [];
  terminated = false;

  postMessage(message: MortalRequest, transfer?: Transferable[]) {
    this.messages.push(message);
    this.transfers.push(transfer);
  }

  terminate() {
    this.terminated = true;
  }

  respond(response: MortalResponse) {
    this.onmessage?.({ data: response } as MessageEvent<MortalResponse>);
  }

  fail(message: string) {
    this.onerror?.({ message } as ErrorEvent);
  }
}

describe('createMortalClient', () => {
  it('correlates out-of-order responses by id', async () => {
    const worker = new FakeWorker();
    const client = createMortalClient(worker);

    const evaluation = client.evaluate('{"players":[]}');
    const generated = client.generateHotseatPuzzle('{}');
    expect(worker.messages.map((message) => message.op)).toEqual([
      'evaluate',
      'generateHotseat',
    ]);

    const [evaluateMessage, generateMessage] = worker.messages;
    worker.respond({
      id: generateMessage.id,
      ok: true,
      value: '{"category":"ai_hotseat"}',
    });
    worker.respond({
      id: evaluateMessage.id,
      ok: true,
      value: { recommended_action: 'Discard_3m' },
    });

    await expect(generated).resolves.toBe('{"category":"ai_hotseat"}');
    await expect(evaluation).resolves.toEqual({
      recommended_action: 'Discard_3m',
    });
  });

  it('sends the AI Hotseat options to the worker', async () => {
    const worker = new FakeWorker();
    const client = createMortalClient(worker);
    const options = JSON.stringify({
      round: 'south_3',
      disparity: null,
      seat: 'west',
    });

    const generated = client.generateHotseatPuzzle(options);
    expect(worker.messages.map((message) => message.op)).toEqual([
      'generateHotseat',
    ]);
    const message = worker.messages[0];
    expect(message).toMatchObject({ op: 'generateHotseat', optionsJson: options });

    worker.respond({
      id: message.id,
      ok: true,
      value: '{"category":"ai_hotseat"}',
    });
    await expect(generated).resolves.toBe('{"category":"ai_hotseat"}');
  });

  it('routes hotseat progress without resolving the promise', async () => {
    const worker = new FakeWorker();
    const client = createMortalClient(worker);
    const seen: Array<{ attempt: number; turn: number; drawn: number }> = [];

    const generated = client.generateHotseatPuzzle('{}', (progress) => {
      seen.push(progress);
    });
    const message = worker.messages[0];

    worker.respond({
      id: message.id,
      progress: { attempt: 1, turn: 3, drawn: 9, wall_left: 60 },
    });
    worker.respond({
      id: message.id,
      progress: { attempt: 1, turn: 4, drawn: 13, wall_left: 56 },
    });
    expect(seen.map((progress) => progress.turn)).toEqual([3, 4]);

    worker.respond({
      id: message.id,
      ok: true,
      value: '{"category":"ai_hotseat"}',
    });
    await expect(generated).resolves.toBe('{"category":"ai_hotseat"}');
  });

  it('rejects with the error the worker reported', async () => {    const worker = new FakeWorker();
    const client = createMortalClient(worker);

    const agreement = client.generatePuzzleWithAgreement(
      'ryankan_break',
      '{"max_candidates":1}',
    );
    const [message] = worker.messages;
    worker.respond({
      id: message.id,
      ok: false,
      error: 'no ryankan_break candidate matched Mortal after 1 attempt(s)',
    });

    await expect(agreement).rejects.toThrow(
      'no ryankan_break candidate matched Mortal after 1 attempt(s)',
    );
  });

  it('ignores a response whose request is gone', () => {
    const worker = new FakeWorker();
    createMortalClient(worker);

    expect(() =>
      worker.respond({ id: 999, ok: true, value: 'stale' }),
    ).not.toThrow();
  });

  it('fails every pending call when the worker crashes', async () => {
    const worker = new FakeWorker();
    const client = createMortalClient(worker);

    const first = client.evaluate('{}');
    const second = client.generateHotseatPuzzle('{}');
    worker.fail('the model could not be loaded');

    await expect(first).rejects.toThrow('the model could not be loaded');
    await expect(second).rejects.toThrow('the model could not be loaded');
  });

  it('terminate rejects pending calls and refuses new ones', async () => {
    const worker = new FakeWorker();
    const client = createMortalClient(worker);

    const pending = client.evaluate('{}');
    client.terminate();

    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toThrow('terminated');
    await expect(client.evaluate('{}')).rejects.toThrow('terminated');
  });

  it('transfers the weights buffer to the worker', async () => {
    const worker = new FakeWorker();
    const client = createMortalClient(worker);
    const weights = new Uint8Array(8);

    const init = client.init(weights.buffer, 'mortal_298k.safetensors');
    expect(worker.messages[0].op).toBe('init');
    expect(worker.transfers[0]).toEqual([weights.buffer]);

    worker.respond({ id: worker.messages[0].id, ok: true });
    await expect(init).resolves.toBeUndefined();
  });
});
