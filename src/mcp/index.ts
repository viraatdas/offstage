#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createOffstageMcpServer } from './server.js';

const server = createOffstageMcpServer();
await server.connect(new StdioServerTransport());
