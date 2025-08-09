import { getHopscotchEnv } from '@hopscotch-trading/js-commons-core/lang';
import { SecretsManager } from '@hopscotch-trading/js-commons-core/services';
import { getLogger } from '@hopscotch-trading/js-commons-core/utils';

const logger = getLogger('utils/secrets');

// Inject secrets from secrets manager into environment
export async function injectSecrets(): Promise<void> {
  if (!getHopscotchEnv()) {
    throw new Error('Missing runtime environment HS_ENV');
  }

  const secretIds = [
    process.env.APP_NAME as string,
    `${process.env.HS_ENV}/${process.env.APP_NAME}`
  ];

  const secrets = await SecretsManager.getSecrets(...secretIds);
  
  for (const key in secrets) {
    process.env[key] = secrets[key] as string;
    logger.debug('Injected secret %s', key);
  }
}