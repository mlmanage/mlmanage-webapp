# MLManage Jobs-first experience

MLManage is a compact, dark GPU job manager. It presents one user-facing **Job** workflow: run work as soon as capacity is available or reserve a precise accelerator window.

## New Job

The New Job sheet starts with the information required to run work: name, optional project, container, command, timing, and a visible **Compute** section. Projects are selected from the available project list; users never need to remember an identifier. Compute explains each request and includes accelerators, GPU memory, CPU, memory, temporary disk with an explicit MiB/GiB/TiB unit, and an ASAP run-time value/unit. The service stops ASAP jobs at the configured time limit.

Exact scheduling presents local-time start/end fields and an availability table built from accelerator inventory and reservation windows. A user selects an available accelerator rather than typing a UUID. A created scheduled Job provides a downloadable calendar event.

Queue dependencies, parallel copies, gang/MPI execution, priority, and MIG slice selection are supported, but they are not prerequisites for a normal job — they live in a collapsed **Advanced scheduling** disclosure below Compute, described in product language ("Start all copies together", "Wait for other jobs") rather than as backend flags. A user who ignores the disclosure gets the same short form as before.

## Capacity

Capacity explains the physical accelerator inventory, how each card is currently shared, the windows the signed-in user holds, and the schedule everyone else holds. Scheduling still begins with **Schedule a job**, which opens the Job workflow; **Reserve a GPU** is the secondary path for holding a window (whole card or MIG slice) before the job exists, with Extend and Release on each window. The schedule can be exported as iCal, subscribed to from a calendar application, or imported from an `.ics` file. Administrators configure a card's sharing mode from its inventory row, choosing only the modes the hardware reports, and MIG geometry is entered as slice counts per profile rather than as a JSON payload.

## Shared work

Projects and groups show members and their shared accelerator/storage allocation. Create and edit are distinct actions; editing starts with the existing record. Job creation from a project carries that project context. Allocation forms use structured fields and GPU-model rows, never JSON.

## Usage and administration

Usage defaults to a clearly defined time period and appropriate scope: people see their own activity and available group/project views; administrators can select a subject. Allocated GPU time and activity come from persisted Job start/finish timestamps and load automatically. Hardware utilization, energy, carbon footprint, temperature, and power are shown only when monitored telemetry exists; synthetic environments never invent those values. Energy and CO₂ lead the view as headline cards, the CO₂ figure is paired with a plain-language comparison and with the formula that produced it, and low utilization is called out in words next to the number. The table exports to CSV for reporting.

**My account** answers "what am I allowed to use?" without an administrator: role, notification addresses, group, scheduling priority, per-model accelerator and VRAM limits, workspace sizes, project access, and the windows currently held. It is read-only, because the backend only lets an administrator change a profile.

Administration uses prefilled account forms, structured allocations, an explicit self-delete guard, and a **Data retention** policy that describes the impact and duration of each setting. Editing an account exposes the notification, group, priority and per-model limit fields the API accepts; the create-time role and account-wide allocations are shown read-only rather than offered as controls that would silently do nothing.
