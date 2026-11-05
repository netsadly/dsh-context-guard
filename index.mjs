import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { BlockAssembler, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import { createGuardPlugin } from './lib/plugin.mjs';
import { makeTokenCounter } from './lib/tokenizer.mjs';
import { LMStudioClient } from '@lmstudio/sdk';

export default createGuardPlugin({ BasicCompactionEngine, toolPairingBalancedBefore, toolPairingBalancedAfter, BlockAssembler, overflowCode: CONTEXT_WINDOW_EXCEEDED_CODE, makeCounter: config => makeTokenCounter(LMStudioClient, config) });
