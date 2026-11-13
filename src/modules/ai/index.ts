/**
 * AI module public surface (P5).
 *
 * Pages are lazy-loaded by the router from their files directly; this barrel is
 * for anything that imports AI UI pieces elsewhere (e.g. the editor's assistant)
 * and keeps the module's public boundary explicit.
 */
export { ApiSettingsPanel } from './ApiSettingsPanel';
export { ProviderManagementPanel } from './ProviderManagementPanel';
export { ModelConfigurationPanel } from './ModelConfigurationPanel';
export { AiAssistancePanel } from './AiAssistancePanel';
export { EditorAiAssistant } from './EditorAiAssistant';
export { PromptTemplatesPanel } from './PromptTemplatesPanel';
export { ContextManagerPanel } from './ContextManagerPanel';
