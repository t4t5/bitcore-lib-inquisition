'use strict';

var inherits = require('inherits');

var $ = require('../../util/preconditions');
var BufferUtil = require('../../util/buffer');

var Address = require('../../address');
var Hash = require('../../crypto/hash');
var Input = require('./input');
var Output = require('../output');
var Sighash = require('../sighash');
var SighashWitness = require('../sighashwitness');
var BufferWriter = require('../../encoding/bufferwriter');
var BufferUtil = require('../../util/buffer');
var Script = require('../../script');
var Signature = require('../../crypto/signature');
var TransactionSignature = require('../signature');

/**
 * Represents a special kind of input of PayToPublicKeyHash kind.
 * @constructor
 */
function PublicKeyHashInput() {
  Input.apply(this, arguments);
}
inherits(PublicKeyHashInput, Input);

PublicKeyHashInput.prototype.getRedeemScript = function(publicKey) {
  if (!this.redeemScript) {
    var redeemScript = Script.buildWitnessV0Out(publicKey);
    if (Script.buildScriptHashOut(redeemScript).equals(this.output.script)) {
      var scriptSig = new Script();
      scriptSig.add(redeemScript.toBuffer());
      this.setScript(scriptSig);
      this.redeemScript = redeemScript;
    }
  }
  return this.redeemScript;
};

PublicKeyHashInput.prototype.getScriptCode = function(publicKey) {
  var writer = new BufferWriter();
  var script;
  if (this.output.script.isScriptHashOut()) {
    script = this.getRedeemScript(publicKey);
  } else {
    script = this.output.script;
  }
  var scriptBuffer = Script.buildPublicKeyHashOut(script.toAddress()).toBuffer();
  writer.writeVarintNum(scriptBuffer.length);
  writer.write(scriptBuffer);
  return writer.toBuffer();
};

PublicKeyHashInput.prototype.getSighash = function(transaction, privateKey, index, sigtype) {
  var scriptCode = this.getScriptCode(privateKey);
  var satoshisBuffer = this.getSatoshisBuffer();
  return SighashWitness.sighash(transaction, sigtype, index, scriptCode, satoshisBuffer);
};

/**
 * @param {Transaction} transaction - the transaction to be signed
 * @param {PrivateKey} privateKey - the private key with which to sign the transaction
 * @param {number} index - the index of the input in the transaction input vector
 * @param {number} sigtype - the type of signature, defaults to Signature.SIGHASH_ALL
 * @param {Buffer} hashData - the precalculated hash of the public key associated with the privateKey provided
 * @param {String} signingMethod - method used to sign - 'ecdsa' or 'schnorr'
 * @param {Buffer} merkleRoot - unused for this input type
 * @return {Array<TransactionSignature>}
 */
PublicKeyHashInput.prototype.getSignatures = function(transaction, privateKey, index, sigtype, hashData, signingMethod, merkleRoot) {
  $.checkState(this.output instanceof Output);
  hashData = hashData || Hash.sha256ripemd160(privateKey.publicKey.toBuffer());
  sigtype = sigtype || Signature.SIGHASH_ALL;
  signingMethod = signingMethod || 'ecdsa'; // unused. Keeping for consistency with other libs

  var script;
  if (this.output.script.isScriptHashOut()) {
    script = this.getRedeemScript(privateKey.publicKey);
  } else {
    script = this.output.script;
  }

  // SKIP VALIDATION (we want to make sure the tx actually fails, not just this library):
  // if (script && BufferUtil.equals(hashData, script.getPublicKeyHash())) {
    var signature;
    if (script.isWitnessPublicKeyHashOut()) {
      var satoshisBuffer = this.getSatoshisBuffer();
      var scriptCode = this.getScriptCode(privateKey.publicKey);
      signature = SighashWitness.sign(transaction, privateKey, sigtype, index, scriptCode, satoshisBuffer);
    } else {
      signature = Sighash.sign(transaction, privateKey, sigtype, index, this.output.script);
    }

    return [new TransactionSignature({
      publicKey: privateKey.publicKey,
      prevTxId: this.prevTxId,
      outputIndex: this.outputIndex,
      inputIndex: index,
      signature: signature,
      sigtype: sigtype
    })];
  // }
  return [];
};
/* jshint maxparams: 3 */

/**
 * Add the provided signature
 *
 * @param {Transaction} transaction
 * @param {Object} signature
 * @param {PublicKey} signature.publicKey
 * @param {Signature} signature.signature
 * @param {number=} signature.sigtype
 * @param {String} signingMethod - method used to sign - 'ecdsa' or 'schnorr' (future signing method)
 * @return {PublicKeyHashInput} this, for chaining
 */
PublicKeyHashInput.prototype.addSignature = function(transaction, signature, signingMethod) {
  // SKIP VALIDATION (we want to make sure the tx actually fails, not just this library):
  // $.checkState(this.isValidSignature(transaction, signature, signingMethod), 'Signature is invalid');

  if (this.output.script.isWitnessPublicKeyHashOut() || this.output.script.isScriptHashOut()) {
    this.setWitnesses([
      BufferUtil.concat([
        signature.signature.toDER(),
        BufferUtil.integerAsSingleByteBuffer(signature.sigtype)
      ]),
      signature.publicKey.toBuffer()
    ]);
  } else {
    this.setScript(Script.buildPublicKeyHashIn(
      signature.publicKey,
      signature.signature.toDER(),
      signature.sigtype
    ));
  }
  return this;
};

/**
 * Clear the input's signature
 * @return {PublicKeyHashInput} this, for chaining
 */
PublicKeyHashInput.prototype.clearSignatures = function() {
  this.setScript(Script.empty());
  this.setWitnesses([]);
  return this;
};

/**
 * Query whether the input is signed
 * @return {boolean}
 */
PublicKeyHashInput.prototype.isFullySigned = function() {
  return this.script.isPublicKeyHashIn() || this.hasWitnesses();
};

PublicKeyHashInput.prototype.isValidSignature = function(transaction, signature, signingMethod) {
  signingMethod = signingMethod || 'ecdsa'; // unused. Keeping for consistency with other libs
  // FIXME: Refactor signature so this is not necessary
  signature.signature.nhashtype = signature.sigtype;
  if (this.output.script.isWitnessPublicKeyHashOut() || this.output.script.isScriptHashOut()) {
    var scriptCode = this.getScriptCode();
    var satoshisBuffer = this.getSatoshisBuffer();
    return SighashWitness.verify(
      transaction,
      signature.signature,
      signature.publicKey,
      signature.inputIndex,
      scriptCode,
      satoshisBuffer
    );
  } else {
    return Sighash.verify(
      transaction,
      signature.signature,
      signature.publicKey,
      signature.inputIndex,
      this.output.script
    );
  }
};


PublicKeyHashInput.SCRIPT_MAX_SIZE = 73 + 34; // sigsize (1 + 72) + pubkey (1 + 33)
PublicKeyHashInput.REDEEM_SCRIPT_SIZE = 1 + 22; // len (1) OP_0 (1) pubkeyhash (1 + 20)

PublicKeyHashInput.prototype._estimateSize = function() {
  let result = this._getBaseSize();
  result += 1; // script size
  const WITNESS_DISCOUNT = 4;
  const witnessSize = PublicKeyHashInput.SCRIPT_MAX_SIZE / WITNESS_DISCOUNT;
  if (this.output.script.isWitnessPublicKeyHashOut()) {
    result += witnessSize;
  } else if (this.output.script.isScriptHashOut()) {
    result += witnessSize + PublicKeyHashInput.REDEEM_SCRIPT_SIZE;
  } else {
    result += PublicKeyHashInput.SCRIPT_MAX_SIZE;
  }
  return result;
};

module.exports = PublicKeyHashInput;
