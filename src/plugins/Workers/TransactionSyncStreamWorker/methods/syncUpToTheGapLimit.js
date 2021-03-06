const logger = require('../../../../logger');


async function getBlockHeight(header) {
  const prevHash = header.prevHash.reverse().toString('hex');

  const prevBlock = await this.transport.getBlockByHash(prevHash);
  try {
    const prevBlockHeight = prevBlock.transactions[0].extraPayload.height;
    return prevBlockHeight + 1;
  } catch (e) {
    const prevBlockHeight = prevBlock.transactions[1].extraPayload.height;
    return prevBlockHeight + 1;
  }
}

function isAnyIntersection(arrayA, arrayB) {
  const intersection = arrayA.filter((e) => arrayB.indexOf(e) > -1);
  return intersection.length > 0;
}

/**
 *
 * @param options
 * @param {string} [options.fromBlockHash]
 * @param {number} count
 * @param {string} network
 * @param {number} [options.fromBlockHeight]
 * @return {Promise<undefined>}
 */
module.exports = async function syncUpToTheGapLimit({
  fromBlockHash, count, network, fromBlockHeight,
}) {
  const self = this;
  const addresses = this.getAddressesToSync();
  logger.debug(`syncing up to the gap limit: - from block: ${fromBlockHash || fromBlockHeight} Count: ${count}`);

  if (fromBlockHash == null && fromBlockHeight == null) {
    throw new Error('fromBlockHash ot fromBlockHeight should be present');
  }

  const options = { count };
  if (fromBlockHash != null) {
    options.fromBlockHash = fromBlockHash;
  } else {
    options.fromBlockHeight = fromBlockHeight;
  }

  const stream = await this.transport
    .subscribeToTransactionsWithProofs(addresses, options);

  if (self.stream) {
    throw new Error('Limited to one stream at the same time.');
  }
  self.stream = stream;
  let reachedGapLimit = false;

  return new Promise((resolve, reject) => {
    stream
      .on('data', async (response) => {
        /* Incoming transactions handling */
        const transactionsFromResponse = this.constructor
          .getTransactionListFromStreamResponse(response);
        const walletTransactions = this.constructor
          .filterWalletTransactions(transactionsFromResponse, addresses, network);

        if (walletTransactions.transactions.length) {
          const addressesGeneratedCount = await self
            .importTransactions(walletTransactions.transactions);

          reachedGapLimit = reachedGapLimit || addressesGeneratedCount > 0;

          if (reachedGapLimit) {
            logger.silly('TransactionSyncStreamWorker - end stream - new addresses generated');
            // If there are some new addresses being imported
            // to the storage, that mean that we hit the gap limit
            // and we need to update the bloom filter with new addresses,
            // i.e. we need to open another stream with a bloom filter
            // that contains new addresses.

            // DO not setting null this.stream allow to know we
            // need to reset our stream (as we pass along the error)
            stream.cancel();
          }
        }

        /* Incoming Merkle block handling */
        const merkleBlockFromResponse = this.constructor
          .getMerkleBlockFromStreamResponse(response);

        if (merkleBlockFromResponse) {
          // Reverse hashes, as they're little endian in the header
          const transactionsInHeader = merkleBlockFromResponse.hashes.map((hashHex) => Buffer.from(hashHex, 'hex').reverse().toString('hex'));
          const transactionsInWallet = Object.keys(self.storage.getStore().transactions);
          const isTruePositive = isAnyIntersection(transactionsInHeader, transactionsInWallet);
          if (isTruePositive) {
            const height = await getBlockHeight.call(this, merkleBlockFromResponse.header);
            self.importBlockHeader(merkleBlockFromResponse.header);
            this.setLastSyncedBlockHeight(height);
          }
        }
      })
      .on('error', (err) => {
        logger.silly('TransactionSyncStreamWorker - end stream on error');
        reject(err);
      })
      .on('end', () => {
        logger.silly('TransactionSyncStreamWorker - end stream on request');
        self.stream = null;
        resolve(reachedGapLimit);
      });
  });
};
