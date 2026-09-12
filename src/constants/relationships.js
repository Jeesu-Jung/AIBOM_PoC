export const RELATION_LABELS = {
  instructionTunedFrom: "Instruction tuned",
  domainFineTunedAndReinforcementOptimizedFrom: "Domain FT + PPO",
  taskFineTunedFrom: "Task fine-tuned",
  adapterTrainedFrom: "Adapter trained",
  convertedFrom: "Converted",
  contextExtendedFrom: "Context extended",
  preferenceOptimizedFrom: "Preference optimized"
};

export const RELATION_SHORT_NOTES = {
  instructionTunedFrom: "Instruction tuning and chat alignment",
  domainFineTunedAndReinforcementOptimizedFrom: "Domain adaptation with reinforcement optimization",
  taskFineTunedFrom: "Task-specific adaptation",
  adapterTrainedFrom: "PEFT or LoRA adapter on top of the base model",
  convertedFrom: "Packaging or runtime conversion without a reported semantic retraining change",
  contextExtendedFrom: "Extended context handling and long-sequence adaptation",
  preferenceOptimizedFrom: "Preference or DPO-style alignment"
};
