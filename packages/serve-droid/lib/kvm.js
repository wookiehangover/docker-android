import { existsSync, readFileSync } from 'node:fs';

function readCpuinfo() {
  try {
    return readFileSync('/proc/cpuinfo', 'utf8');
  } catch {
    return '';
  }
}

export function kvmHelp({
  platform = process.platform,
  arch = process.arch,
  cpuinfo = readCpuinfo(),
  inContainer = existsSync('/.dockerenv') || existsSync('/run/.containerenv'),
} = {}) {
  const lead = 'Starting the emulator needs KVM, but /dev/kvm is missing.';
  if (platform !== 'linux') return 'Starting the emulator needs macOS, or a Linux host with KVM.';
  if (arch !== 'x64') return `The emulator image needs an x86_64 Linux host. This host is ${arch}.`;
  if (inContainer) {
    return `${lead}\nserve-droid is running in a container. Start that container with --device /dev/kvm, or run serve-droid on the host.`;
  }
  const flags = new Set(cpuinfo.match(/^flags\s*:(.*)$/m)?.[1].trim().split(/\s+/) ?? []);
  if (!flags.size) return lead;
  const cpu = flags.has('vmx') ? 'intel' : flags.has('svm') ? 'amd' : null;
  if (cpu) {
    return `${lead}\nThe CPU supports virtualization, but the KVM module is not loaded. Run: sudo modprobe kvm_${cpu}`;
  }
  if (flags.has('hypervisor')) {
    return `${lead}\nThis host is a virtual machine without nested virtualization. Turn on nested virtualization for the VM in your cloud or hypervisor settings, then restart the VM.`;
  }
  return `${lead}\nHardware virtualization is off. Turn on Intel VT-x or AMD-V (SVM) in the BIOS or UEFI settings, then restart.`;
}
