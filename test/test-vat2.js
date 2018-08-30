import { test } from 'tape-promise/tape';
import { confineVatSource, makeRealm, buildVat, bundleCode } from '../src/main';
import { makeTranscript, funcToSource, makeQueues } from './util';

function t1_sender() {
  exports.default = function(argv) {
    let answer = 'unanswered';
    Vow.resolve(argv.target).e.pleaseRespond('marco')
      .then(res => {
        log(`got answer: ${res}`);
        answer = res;
      });
    return {
      getAnswer() { return answer; },
    };
  };
}

function t1_responder() {
  exports.default = function(argv) {
    let called = false;
    return {
      pleaseRespond(arg) {
        called = true;
        log(`pleaseRespond called with ${arg}`);
        return `${arg}-polo`;
      },
      getCalled() { return called; },
    };
  };
}


test('comms, sending a message', async (t) => {
  const tr = makeTranscript();
  const s = makeRealm();
  const v1src = funcToSource(t1_sender);
  const v1 = await buildVat(s, 'vat1', tr.writeOutput, v1src);
  const v1argv = { target: v1.createPresence('vat2/0') };
  const v1root = await v1.initializeCode('vat1/0', v1argv);

  const v2src = funcToSource(t1_responder);
  const v2 = await buildVat(s, 'vat2', tr.writeOutput, v2src);
  const v2argv = {};
  const v2root = await v2.initializeCode('vat2/0', v2argv);
  const q = makeQueues(t);
  let got;

  v1.connectionMade('vat2', q.addQueue(1, 2));
  v2.connectionMade('vat1', q.addQueue(2, 1));

  got = q.expect(1, 2, { seqnum: 0, op: 'send',
                         resultSwissbase: 'base-1',
                         targetSwissnum: '0',
                         methodName: 'pleaseRespond',
                         args: ['marco'],
                       });
  v2.commsReceived('vat1', got);

  // that immediately provokes an ack

  q.expectAndDeliverAck(2, 1, v1, 0);

  // the pleaseRespond isn't executed until a turn later
  q.expectEmpty(2, 1);
  t.equal(v2root.getCalled(), false);
  await Promise.resolve(0);
  t.equal(v2root.getCalled(), true);

  got = q.expect(2, 1, { seqnum: 0, op: 'resolve',
                         targetSwissnum: 'hash-of-base-1',
                         value: 'marco-polo',
                       });

  q.expectEmpty(1, 2);
  t.equal(v1root.getAnswer(), 'unanswered');

  // deliver the response
  v1.commsReceived('vat2', got);
  // that takes a turn to be processed
  await Promise.resolve(0);

  t.equal(v1root.getAnswer(), 'marco-polo');

  t.end();
});


function t2_sender() {
  exports.default = function(argv) {
    let r1;
    const v1 = new Flow().makeVow(res => r1 = res);
    Vow.resolve(argv.target).e.pleaseWait(v1);
    return {
      fire(arg) { r1(arg); },
    };
  };
}

function t2_responder() {
  exports.default = function(argv) {
    let called = false;
    let answer = 'not yet';
    return {
      pleaseWait(arg) {
        log(`pleaseWait called with ${arg}`);
        called = true;
        Vow.resolve(arg).then(res => {
          log(`resolved`);
          answer = res;
        });
      },
      getCalled() { return called; },
      getAnswer() { return answer; },
    };
  };
}


test('sending unresolved local Vow', async (t) => {
  const tr = makeTranscript();
  const s = makeRealm();
  const v1src = funcToSource(t2_sender);
  const v1 = await buildVat(s, 'vat1', tr.writeOutput, v1src);
  const v1argv = { target: v1.createPresence('vat2/0') };
  const v1root = await v1.initializeCode('vat1/0', v1argv);

  const v2src = funcToSource(t2_responder);
  const v2 = await buildVat(s, 'vat2', tr.writeOutput, v2src);
  const v2argv = {};
  const v2root = await v2.initializeCode('vat2/0', v2argv);
  const q = makeQueues(t);
  let got;

  v1.connectionMade('vat2', q.addQueue(1, 2));
  v2.connectionMade('vat1', q.addQueue(2, 1));

  got = q.expect(1, 2, { seqnum: 0, op: 'send',
                         resultSwissbase: 'base-1',
                         targetSwissnum: '0',
                         methodName: 'pleaseWait',
                         args: [{'@qclass': 'unresolvedVow',
                                 vatID: 'vat1',
                                 swissnum: 2}],
                       });
  q.expectEmpty(1, 2);
  v2.commsReceived('vat1', got);
  // that immediately provokes an ack

  // deliver the ack, doesn't cause any interesting externally-visible
  // changes, and doesn't provoke any outbound messages
  q.expectAndDeliverAck(2, 1, v1, 0);
  q.expectEmpty(2, 1);
  q.expectEmpty(1, 2);

  // the pleaseRespond isn't executed until a turn later
  t.equal(v2root.getCalled(), false);
  await Promise.resolve(0);
  t.equal(v2root.getCalled(), true);

  got = q.expect(2, 1, { seqnum: 0, op: 'resolve',
                         targetSwissnum: 'hash-of-base-1',
                         value: {'@qclass': 'undefined' },
                       });
  t.equal(v2root.getAnswer(), 'not yet');

  // pleaseWait() returned 'undefined', so now the caller's Vow gets resolved
  // (although nobody cares)
  v1.commsReceived('vat2', got);
  // that takes a turn to be processed
  await Promise.resolve(0);
  t.equal(v2root.getAnswer(), 'not yet');

  // that sends another ack
  q.expectAndDeliverAck(1, 2, v2, 0);

  // now tell the sender to resolve the Vow they sent to the responder
  v1root.fire('pretty');
  q.expectEmpty(1, 2);

  await Promise.resolve(0);

  got = q.expect(1, 2, { seqnum: 1, op: 'resolve',
                         targetSwissnum: 2,
                         value: 'pretty',
                       });
  v2.commsReceived('vat1', got);
  q.expectAndDeliverAck(2, 1, v1, 1);

  t.equal(v2root.getAnswer(), 'not yet');
  await Promise.resolve(0);
  t.equal(v2root.getAnswer(), 'pretty');

  t.end();
});



function t3_one() {
  exports.default = function(argv) {
    const two = Vow.resolve(argv.target2).e.getVow();
    const three = Vow.resolve(argv.target3).e.pleaseWait(two);
  };
}

function t3_two() {
  exports.default = function(argv) {
    let r;
    const vtwo = new Flow().makeVow(res => r = res);
    return {
      getVow(arg) { log('getVow'); return vtwo; },
      fire(arg) { r(arg); },
    };
  };
}

function t3_three() {
  exports.default = function(argv) {
    let fired = false;
    return {
      pleaseWait(vtwo) {
        Vow.resolve(vtwo).then(res => fired = res);
      },
      getFired() { return fired; },
    };
  };
}

test('sending third-party Vow', async (t) => {
  const tr = makeTranscript();
  const s = makeRealm();
  const v1src = funcToSource(t3_one);
  const v1 = await buildVat(s, 'vat1', tr.writeOutput, v1src);
  const v1argv = { target2: v1.createPresence('vat2/0'),
                   target3: v1.createPresence('vat3/0'),
                 };
  const v1root = await v1.initializeCode('vat1/0', v1argv);

  const v2src = funcToSource(t3_two);
  const v2 = await buildVat(s, 'vat2', tr.writeOutput, v2src);
  const v2argv = {};
  const v2root = await v2.initializeCode('vat2/0', v2argv);

  const v3src = funcToSource(t3_three);
  const v3 = await buildVat(s, 'vat3', tr.writeOutput, v3src);
  const v3argv = {};
  const v3root = await v3.initializeCode('vat3/0', v3argv);
  const q = makeQueues(t);

  v1.connectionMade('vat2', q.addQueue(1, 2));
  v1.connectionMade('vat3', q.addQueue(1, 3));
  v2.connectionMade('vat1', q.addQueue(2, 1));
  v3.connectionMade('vat1', q.addQueue(3, 1));

  let got;

  got = q.expect(1, 2, { seqnum: 0, op: 'send',
                         resultSwissbase: 'base-1',
                         targetSwissnum: '0',
                         methodName: 'getVow',
                         args: [],
                       });
  v2.commsReceived('vat1', got);

  // that immediately provokes an ack

  q.expectAndDeliverAck(2, 1, v1, 0);

  // the getVow isn't executed until a turn later
  await Promise.resolve(0);

  // because getVow() returned an unresolved Vow, no opResolve is sent yet:
  // nothing is sent until it is resolved by v2root.fire()
  q.expectEmpty(2, 1);

  // we don't currently forward unresolved vows to their most-likely target,
  // so when we send 'two' to three.pleaseWait, we send a vat1 vow, not the
  // original vat2 vow
  got = q.expect(1, 3,
                 { seqnum: 0, op: 'send',
                   resultSwissbase: 'base-2',
                   targetSwissnum: '0',
                   methodName: 'pleaseWait',
                   args: [{ '@qclass': 'unresolvedVow',
                            vatID: 'vat1', // owned by vat1
                            swissnum: 3,
                          }],
                 });
  q.expectEmpty(3, 1);
  v3.commsReceived('vat1', got);

  // that returns an immediate ack, and a turn later we send a (for
  // 'undefined') of the answer to pleaseWait()

  q.expectAndDeliverAck(3, 1, v1, 0);
  q.expectEmpty(3, 1);
  await Promise.resolve(0);
  got = q.expect(3, 1, { seqnum: 0, op: 'resolve',
                         targetSwissnum: 'hash-of-base-2',
                         value: {'@qclass': 'undefined' },
                       });
  q.expectEmpty(3, 1);

  v1.commsReceived('vat3', got);

  q.expectAndDeliverAck(1, 3, v3, 0);

  t.equal(v3root.getFired(), false);
  // ok, now we tell vat2 to resolve the Vow, and we expect vat3 to
  // eventually be notified
  console.log('FIRE IN THE HOLE');
  v2root.fire('burns');

  // nothing happens for a turn
  q.expectEmpty(2, 1);
  await Promise.resolve(0);

  // first, vat2 should tell vat1 about the resolution
  got = q.expect(2, 1, { seqnum: 0, op: 'resolve',
                         targetSwissnum: 'hash-of-base-1',
                         value: 'burns',
                       });

  v1.commsReceived('vat2', got);
  q.expectAndDeliverAck(1, 2, v2, 0);

  // and vat1 now tells vat3 about the resolution, after a turn
  q.expectEmpty(1, 3);
  await Promise.resolve(0);
  got = q.expect(1, 3, { seqnum: 1, op: 'resolve',
                         targetSwissnum: 3,
                         value: 'burns',
                       });
  v3.commsReceived('vat1', got);

  t.equal(v3root.getFired(), false);
  await Promise.resolve(0);
  t.equal(v3root.getFired(), 'burns');

  q.expectAndDeliverAck(3, 1, v1, 1);

  t.end();
});