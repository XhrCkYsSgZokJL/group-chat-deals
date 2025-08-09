import { getLogger } from '@hopscotch-trading/js-commons-core/utils';
import { DecodedMessage } from '@xmtp/node-sdk';
import { WorkerInstance } from 'workers';

const name = 'deal';
const logger = getLogger(name);

// Message handler function for deal.hopscotch.eth
export default async function dealHandler(
  worker: WorkerInstance,
  message: DecodedMessage,
): Promise<void> {
  logger.info(`[${worker.name}] Processing deal message ${message.id} from conversation ${message.conversationId}`);


  /* 
    1. determine if being tagged or replied to
    2.  

  */



}