export const ACP_SESSION_UPDATE_TYPES = {
    agentMessageChunk: 'agent_message_chunk',
    agentThoughtChunk: 'agent_thought_chunk',
    toolCall: 'tool_call',
    toolCallUpdate: 'tool_call_update',
    plan: 'plan',
    planUpdate: 'plan_update',
    usageUpdate: 'usage_update',
    sessionInfoUpdate: 'session_info_update',
    currentModeUpdate: 'current_mode_update',
    configOptionUpdate: 'config_option_update'
} as const;
