#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import getenv from 'getenv';

const QUICKCHART_BASE_URL = getenv('QUICKCHART_BASE_URL', 'https://quickchart.io/chart');

interface ChartConfig {
  type: string;
  data: {
    labels?: string[];
    datasets: Array<{
      label?: string;
      data: number[];
      backgroundColor?: string | string[];
      borderColor?: string | string[];
      [key: string]: any;
    }>;
    [key: string]: any;
  };
  options?: {
    title?: {
      display: boolean;
      text: string;
    };
    scales?: {
      y?: {
        beginAtZero?: boolean;
      };
    };
    [key: string]: any;
  };
}

class QuickChartServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'quickchart-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private validateChartType(type: string): void {
    const validTypes = [
      'bar', 'line', 'pie', 'doughnut', 'radar',
      'polarArea', 'scatter', 'bubble', 'radialGauge', 'speedometer'
    ];
    if (!validTypes.includes(type)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid chart type. Must be one of: ${validTypes.join(', ')}`
      );
    }
  }

  private generateChartConfig(args: any): ChartConfig {
    // Add defensive checks to handle possibly malformed input
    if (!args) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'No arguments provided to generateChartConfig'
      );
    }
    
    if (!args.type) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Chart type is required'
      );
    }
    
    if (!args.datasets || !Array.isArray(args.datasets)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Datasets must be a non-empty array'
      );
    }
    
    const { type, labels, datasets, title, options = {} } = args;
    
    this.validateChartType(type);

    const config: ChartConfig = {
      type,
      data: {
        labels: labels || [],
        datasets: datasets.map((dataset: any) => {
          if (!dataset || !dataset.data) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Each dataset must have a data property'
            );
          }
          return {
            label: dataset.label || '',
            data: dataset.data,
            backgroundColor: dataset.backgroundColor,
            borderColor: dataset.borderColor,
            ...(dataset.additionalConfig || {})
          };
        })
      },
      options: {
        ...options,
        ...(title && {
          title: {
            display: true,
            text: title
          }
        })
      }
    };

    // Special handling for specific chart types
    switch (type) {
      case 'radialGauge':
      case 'speedometer':
        if (!datasets?.[0]?.data?.[0]) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `${type} requires a single numeric value`
          );
        }
        config.options = {
          ...config.options,
          plugins: {
            datalabels: {
              display: true,
              formatter: (value: number) => value
            }
          }
        };
        break;

      case 'scatter':
      case 'bubble':
        datasets.forEach((dataset: any) => {
          if (!Array.isArray(dataset.data[0])) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `${type} requires data points in [x, y${type === 'bubble' ? ', r' : ''}] format`
            );
          }
        });
        break;
    }

    return config;
  }

  private async generateChartUrl(config: ChartConfig): Promise<string> {
    const encodedConfig = encodeURIComponent(JSON.stringify(config));
    return `${QUICKCHART_BASE_URL}?c=${encodedConfig}`;
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'generate_chart',
          description: 'Generate a chart using QuickChart',
          inputSchema: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                description: 'Chart type (bar, line, pie, doughnut, radar, polarArea, scatter, bubble, radialGauge, speedometer)'
              },
              labels: {
                type: 'array',
                items: { type: 'string' },
                description: 'Labels for data points'
              },
              datasets: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    data: { type: 'array' , items: { type: 'number' } },
                    backgroundColor: { 
                      oneOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } }
                      ]
                    },
                    borderColor: {
                      oneOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } }
                      ]
                    },
                    additionalConfig: { type: 'object' }
                  },
                  required: ['data']
                }
              },
              title: { type: 'string' },
              options: { type: 'object' }
            },
            required: ['type', 'datasets']
          }
        },
        {
          name: 'download_chart',
          description: 'Download a chart image to a local file',
          inputSchema: {
            type: 'object',
            properties: {
              config: {
                type: 'object',
                description: 'Chart configuration object'
              },
              outputPath: {
                type: 'string',
                description: 'Path where the chart image should be saved. If not provided, the chart will be saved to Desktop or home directory.'
              }
            },
            required: ['config']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'generate_chart': {
          try {
            const config = this.generateChartConfig(request.params.arguments);
            const url = await this.generateChartUrl(config);
            return {
              content: [
                {
                  type: 'text',
                  text: url
                }
              ]
            };
          } catch (error: any) {
            if (error instanceof McpError) {
              throw error;
            }
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to generate chart: ${error?.message || 'Unknown error'}`
            );
          }
        }

        case 'download_chart': {
          try {
            const { config, outputPath: userProvidedPath } = request.params.arguments as { 
              config: Record<string, unknown>;
              outputPath?: string;
            };
            
            // Validate and normalize config first
            if (!config || typeof config !== 'object') {
              throw new McpError(
                ErrorCode.InvalidParams,
                'Config must be a valid chart configuration object'
              );
            }
            
            // Handle both direct properties and nested properties in 'data'
            let normalizedConfig: any = { ...config };
            
            // If config has data property with datasets, extract them
            if (config.data && typeof config.data === 'object' && 
                (config.data as any).datasets && !normalizedConfig.datasets) {
              normalizedConfig.datasets = (config.data as any).datasets;
            }
            
            // If config has data property with labels, extract them
            if (config.data && typeof config.data === 'object' && 
                (config.data as any).labels && !normalizedConfig.labels) {
              normalizedConfig.labels = (config.data as any).labels;
            }
            
            // If type is inside data object but not at root, extract it
            if (config.data && typeof config.data === 'object' && 
                (config.data as any).type && !normalizedConfig.type) {
              normalizedConfig.type = (config.data as any).type;
            }
            
            // Final validation after normalization
            if (!normalizedConfig.type || !normalizedConfig.datasets) {
              throw new McpError(
                ErrorCode.InvalidParams,
                'Config must include type and datasets properties (either at root level or inside data object)'
              );
            }
            
            // Generate default outputPath if not provided
            const fs = await import('fs');
            const path = await import('path');
            const os = await import('os');
            
            let outputPath = userProvidedPath;
            if (!outputPath) {
              // Get home directory
              const homeDir = os.homedir();
              const desktopDir = path.join(homeDir, 'Desktop');
              
              // Check if Desktop directory exists and is writable
              let baseDir = homeDir;
              try {
                await fs.promises.access(desktopDir, fs.constants.W_OK);
                baseDir = desktopDir; // Desktop exists and is writable
              } catch (error) {
                // Desktop doesn't exist or is not writable, use home directory
                console.error('Desktop not accessible, using home directory instead');
              }
              
              // Generate a filename based on chart type and timestamp
              const timestamp = new Date().toISOString()
                .replace(/:/g, '-')
                .replace(/\..+/, '')
                .replace('T', '_');
              const chartType = normalizedConfig.type || 'chart';
              outputPath = path.join(baseDir, `${chartType}_${timestamp}.png`);
              
              console.error(`No output path provided, using: ${outputPath}`);
            }
            
            // Check if the output directory exists and is writable
            const outputDir = path.dirname(outputPath);
            
            try {
              await fs.promises.access(outputDir, fs.constants.W_OK);
            } catch (error) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Output directory does not exist or is not writable: ${outputDir}`
              );
            }
            
            const chartConfig = this.generateChartConfig(normalizedConfig);
            const url = await this.generateChartUrl(chartConfig);
            
            try {
              const response = await axios.get(url, { responseType: 'arraybuffer' });
              await fs.promises.writeFile(outputPath, response.data);
            } catch (error: any) {
              if (error.code === 'EACCES' || error.code === 'EROFS') {
                throw new McpError(
                  ErrorCode.InvalidParams,
                  `Cannot write to ${outputPath}: Permission denied`
                );
              }
              if (error.code === 'ENOENT') {
                throw new McpError(
                  ErrorCode.InvalidParams,
                  `Cannot write to ${outputPath}: Directory does not exist`
                );
              }
              throw error;
            }
            
            return {
              content: [
                {
                  type: 'text',
                  text: `Chart saved to ${outputPath}`
                }
              ]
            };
          } catch (error: any) {
            if (error instanceof McpError) {
              throw error;
            }
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to download chart: ${error?.message || 'Unknown error'}`
            );
          }
        }

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('QuickChart MCP server running on stdio');
  }
}

const server = new QuickChartServer();
server.run().catch(console.error);
