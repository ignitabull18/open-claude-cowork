/**
 * Tasks — Kanban / Calendar / List views
 * IIFE that attaches to window.tasksView for use by renderer.js.
 */
(function () {
  'use strict';

  // ==================== STATE ====================
  let currentSubView = 'kanban';
  let tasks = [];
  let labels = [];
  let filters = { status: '', priority: '', label: '', search: '' };
  let calendarDate = new Date();
  let calendarMode = 'month'; // 'month' | 'week'
  let dragState = { taskId: null, originStatus: null };
  let sortColumn = 'due_date';
  let sortDir = 'asc';

  const STATUSES = [
    { key: 'backlog', label: 'Backlog' },
    { key: 'todo', label: 'To Do' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'done', label: 'Done' },
    { key: 'cancelled', label: 'Cancelled' }
  ];

  const PRIORITIES = { 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };
  const PRIORITY_COLORS = { 1: '#dc2626', 2: '#ea580c', 3: '#2563eb', 4: '#9ca3af' };

  const api = () => window.electronAPI;

  // ==================== DOM REFS ====================
  const $ = (id) => document.getElementById(id);

  // ==================== LOAD ====================
  async function load() {
    try {
      const [t, l] = await Promise.all([
        api().getTasks(),
        api().getTaskLabels()
      ]);
      tasks = t || [];
      labels = l || [];
    } catch (e) {
      console.error('Failed to load tasks:', e);
      tasks = [];
      labels = [];
    }
    populateLabelFilter();
    render();
    bindEvents();
  }

  let bound = false;
  function bindEvents() {
    if (bound) return;
    bound = true;

    // View switcher tabs
    document.querySelectorAll('.tasks-view-tab').forEach(btn => {
      btn.addEventListener('click', () => switchSubView(btn.dataset.view));
    });

    // New task
    $('tasksNewBtn')?.addEventListener('click', () => openTaskModal());

    // Filters
    $('tasksFilterStatus')?.addEventListener('change', e => { filters.status = e.target.value; render(); });
    $('tasksFilterPriority')?.addEventListener('change', e => { filters.priority = e.target.value; render(); });
    $('tasksFilterLabel')?.addEventListener('change', e => { filters.label = e.target.value; render(); });

    let searchTimer;
    $('tasksFilterSearch')?.addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { filters.search = e.target.value; render(); }, 250);
    });

    // Modal
    $('taskModalClose')?.addEventListener('click', closeTaskModal);
    $('taskModalCancelBtn')?.addEventListener('click', closeTaskModal);
    $('taskModalSaveBtn')?.addEventListener('click', saveTask);
    $('taskModalDeleteBtn')?.addEventListener('click', deleteCurrentTask);
    $('taskModal')?.addEventListener('click', e => {
      if (e.target.id === 'taskModal') closeTaskModal();
    });
  }

  // ==================== FILTERING ====================
  function filteredTasks() {
    return tasks.filter(t => {
      if (filters.status && t.status !== filters.status) return false;
      if (filters.priority && t.priority !== Number(filters.priority)) return false;
      if (filters.label) {
        const hasLabel = (t.labels || []).some(l => l.id === filters.label);
        if (!hasLabel) return false;
      }
      if (filters.search) {
        const q = filters.search.toLowerCase();
        if (!t.title.toLowerCase().includes(q) && !(t.description || '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  function populateLabelFilter() {
    const sel = $('tasksFilterLabel');
    if (!sel) return;
    // Rebuild options using safe DOM methods
    while (sel.options.length > 1) sel.remove(1);
    labels.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = l.name;
      sel.appendChild(opt);
    });
  }

  // ==================== VIEW SWITCHING ====================
  function switchSubView(view) {
    currentSubView = view;
    document.querySelectorAll('.tasks-view-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
    $('tasksKanbanView')?.classList.toggle('hidden', view !== 'kanban');
    $('tasksCalendarView')?.classList.toggle('hidden', view !== 'calendar');
    $('tasksListView')?.classList.toggle('hidden', view !== 'list');
    render();
  }

  function render() {
    const ft = filteredTasks();
    if (currentSubView === 'kanban') renderKanban(ft);
    else if (currentSubView === 'calendar') renderCalendar(ft);
    else if (currentSubView === 'list') renderList(ft);
  }

  // ==================== KANBAN ====================
  function renderKanban(ft) {
    const container = $('tasksKanbanView');
    if (!container) return;
    container.textContent = '';

    STATUSES.forEach(s => {
      const col = ft.filter(t => t.status === s.key).sort((a, b) => a.position - b.position);

      const colEl = document.createElement('div');
      colEl.className = 'kanban-column';
      colEl.dataset.status = s.key;

      const header = document.createElement('div');
      header.className = 'kanban-column-header';
      const titleSpan = document.createElement('span');
      titleSpan.className = 'kanban-column-title';
      titleSpan.textContent = s.label;
      const countSpan = document.createElement('span');
      countSpan.className = 'kanban-column-count';
      countSpan.textContent = col.length;
      header.appendChild(titleSpan);
      header.appendChild(countSpan);
      colEl.appendChild(header);

      const cardList = document.createElement('div');
      cardList.className = 'kanban-card-list';
      cardList.dataset.status = s.key;

      col.forEach(t => cardList.appendChild(buildKanbanCard(t)));

      cardList.addEventListener('dragover', handleDragOver);
      cardList.addEventListener('dragleave', e => e.currentTarget.classList.remove('drag-over'));
      cardList.addEventListener('drop', handleDrop);

      colEl.appendChild(cardList);
      container.appendChild(colEl);
    });
  }

  function buildKanbanCard(t) {
    const priColor = PRIORITY_COLORS[t.priority] || '#9ca3af';
    const priLabel = PRIORITIES[t.priority] || '';

    const card = document.createElement('div');
    card.className = 'kanban-card';
    card.draggable = true;
    card.dataset.id = t.id;
    card.dataset.status = t.status;

    const priBorder = document.createElement('div');
    priBorder.className = 'kanban-card-priority';
    priBorder.style.background = priColor;
    priBorder.title = priLabel;
    card.appendChild(priBorder);

    const body = document.createElement('div');
    body.className = 'kanban-card-body';

    const titleEl = document.createElement('div');
    titleEl.className = 'kanban-card-title';
    titleEl.textContent = t.title;
    body.appendChild(titleEl);

    const meta = document.createElement('div');
    meta.className = 'kanban-card-meta';

    if (t.due_date) {
      const dueSpan = document.createElement('span');
      dueSpan.className = 'kanban-card-due' + (isOverdue(t) ? ' overdue' : '');
      dueSpan.textContent = formatDate(t.due_date);
      meta.appendChild(dueSpan);
    }

    if (t.labels && t.labels.length > 0) {
      const labelsDiv = document.createElement('div');
      labelsDiv.className = 'kanban-card-labels';
      t.labels.forEach(l => {
        const chip = document.createElement('span');
        chip.className = 'task-label-chip';
        chip.style.background = l.color;
        chip.textContent = l.name;
        labelsDiv.appendChild(chip);
      });
      meta.appendChild(labelsDiv);
    }

    body.appendChild(meta);
    card.appendChild(body);

    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragend', handleDragEnd);
    card.addEventListener('click', () => openTaskModal(t));

    return card;
  }

  // ---- Drag & Drop ----
  function handleDragStart(e) {
    dragState.taskId = e.currentTarget.dataset.id;
    dragState.originStatus = e.currentTarget.dataset.status;
    e.currentTarget.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
  }

  async function handleDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    const newStatus = e.currentTarget.dataset.status;
    const taskId = dragState.taskId;
    if (!taskId) return;

    // Calculate new position (append at end of column)
    const colTasks = tasks.filter(t => t.status === newStatus).sort((a, b) => a.position - b.position);
    const newPosition = colTasks.length > 0 ? colTasks[colTasks.length - 1].position + 1 : 0;

    // Optimistic update
    const task = tasks.find(t => t.id === taskId);
    if (task) {
      task.status = newStatus;
      task.position = newPosition;
      render();
    }

    try {
      await api().reorderTask(taskId, newStatus, newPosition);
    } catch (err) {
      console.error('Reorder failed:', err);
      await load();
    }
    dragState = { taskId: null, originStatus: null };
  }

  // ==================== CALENDAR ====================
  function renderCalendar(ft) {
    const container = $('tasksCalendarView');
    if (!container) return;
    container.textContent = '';

    // Header row
    const headerRow = document.createElement('div');
    headerRow.className = 'calendar-header';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'calendar-nav';
    prevBtn.textContent = '\u2039';
    prevBtn.addEventListener('click', () => {
      if (calendarMode === 'month') calendarDate.setMonth(calendarDate.getMonth() - 1);
      else calendarDate.setDate(calendarDate.getDate() - 7);
      render();
    });

    const titleSpan = document.createElement('span');
    titleSpan.className = 'calendar-title';
    titleSpan.textContent = calendarDate.toLocaleString('default', { month: 'long', year: 'numeric' });

    const nextBtn = document.createElement('button');
    nextBtn.className = 'calendar-nav';
    nextBtn.textContent = '\u203A';
    nextBtn.addEventListener('click', () => {
      if (calendarMode === 'month') calendarDate.setMonth(calendarDate.getMonth() + 1);
      else calendarDate.setDate(calendarDate.getDate() + 7);
      render();
    });

    const modeBtn = document.createElement('button');
    modeBtn.className = 'calendar-mode-toggle';
    modeBtn.textContent = calendarMode === 'month' ? 'Week' : 'Month';
    modeBtn.addEventListener('click', () => { calendarMode = calendarMode === 'month' ? 'week' : 'month'; render(); });

    headerRow.append(prevBtn, titleSpan, nextBtn, modeBtn);
    container.appendChild(headerRow);

    // Weekday names
    const weekdaysRow = document.createElement('div');
    weekdaysRow.className = 'calendar-weekdays';
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => {
      const el = document.createElement('div');
      el.className = 'calendar-weekday';
      el.textContent = d;
      weekdaysRow.appendChild(el);
    });
    container.appendChild(weekdaysRow);

    // Grid
    const grid = document.createElement('div');
    grid.className = 'calendar-grid';

    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();

    if (calendarMode === 'month') {
      buildMonthGridDOM(grid, year, month, ft);
    } else {
      buildWeekGridDOM(grid, year, month, calendarDate.getDate(), ft);
    }
    container.appendChild(grid);
  }

  function buildMonthGridDOM(grid, year, month, ft) {
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    const todayStr = formatISO(today);

    for (let i = 0; i < firstDay; i++) {
      const empty = document.createElement('div');
      empty.className = 'calendar-day empty';
      grid.appendChild(empty);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      grid.appendChild(buildDayCell(dateStr, dateStr === todayStr, ft, false));
    }
  }

  function buildWeekGridDOM(grid, year, month, day, ft) {
    const current = new Date(year, month, day);
    const startOfWeek = new Date(current);
    startOfWeek.setDate(current.getDate() - current.getDay());
    const today = new Date();
    const todayStr = formatISO(today);

    for (let i = 0; i < 7; i++) {
      const d = new Date(startOfWeek);
      d.setDate(startOfWeek.getDate() + i);
      const dateStr = formatISO(d);
      grid.appendChild(buildDayCell(dateStr, dateStr === todayStr, ft, true));
    }
  }

  function buildDayCell(dateStr, isToday, ft, isWeek) {
    const dayTasks = ft.filter(t => t.due_date && t.due_date.substring(0, 10) === dateStr);
    const cell = document.createElement('div');
    cell.className = 'calendar-day' + (isWeek ? ' week-day' : '') + (isToday ? ' today' : '');
    cell.dataset.date = dateStr;

    const dayNum = document.createElement('span');
    dayNum.className = 'calendar-day-num';
    dayNum.textContent = parseInt(dateStr.split('-')[2], 10);
    cell.appendChild(dayNum);

    const tasksDiv = document.createElement('div');
    tasksDiv.className = 'calendar-day-tasks';

    const limit = isWeek ? dayTasks.length : 3;
    dayTasks.slice(0, limit).forEach(t => {
      const chip = document.createElement('div');
      chip.className = 'calendar-task-chip';
      chip.dataset.id = t.id;
      chip.style.borderLeft = `3px solid ${PRIORITY_COLORS[t.priority] || '#9ca3af'}`;
      chip.textContent = t.title;
      chip.addEventListener('click', e => { e.stopPropagation(); openTaskModal(t); });
      tasksDiv.appendChild(chip);
    });

    if (!isWeek && dayTasks.length > 3) {
      const more = document.createElement('span');
      more.className = 'calendar-more';
      more.textContent = `+${dayTasks.length - 3}`;
      tasksDiv.appendChild(more);
    }

    cell.appendChild(tasksDiv);
    cell.addEventListener('click', e => {
      if (e.target.closest('.calendar-task-chip')) return;
      openTaskModal(null, dateStr);
    });

    return cell;
  }

  // ==================== LIST ====================
  function renderList(ft) {
    const container = $('tasksListView');
    if (!container) return;
    container.textContent = '';

    const sorted = [...ft].sort((a, b) => {
      let va, vb;
      if (sortColumn === 'title') { va = a.title.toLowerCase(); vb = b.title.toLowerCase(); }
      else if (sortColumn === 'status') { va = a.status; vb = b.status; }
      else if (sortColumn === 'priority') { va = a.priority; vb = b.priority; }
      else if (sortColumn === 'due_date') { va = a.due_date || '9999'; vb = b.due_date || '9999'; }
      else { va = ''; vb = ''; }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    const table = document.createElement('table');
    table.className = 'tasks-table';

    // thead
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const columns = [
      { key: 'title', label: 'Title', sortable: true },
      { key: 'status', label: 'Status', sortable: true },
      { key: 'priority', label: 'Priority', sortable: true },
      { key: 'due_date', label: 'Due Date', sortable: true },
      { key: 'labels', label: 'Labels', sortable: false }
    ];

    columns.forEach(col => {
      const th = document.createElement('th');
      th.textContent = col.label;
      if (col.sortable) {
        th.className = 'sortable';
        th.dataset.col = col.key;
        if (sortColumn === col.key) th.textContent += sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
        th.addEventListener('click', () => {
          if (sortColumn === col.key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
          else { sortColumn = col.key; sortDir = 'asc'; }
          render();
        });
      }
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    // tbody
    const tbody = document.createElement('tbody');
    if (sorted.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'tasks-empty';
      td.textContent = 'No tasks found';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      sorted.forEach(t => tbody.appendChild(buildListRow(t)));
    }
    table.appendChild(tbody);
    container.appendChild(table);
  }

  function buildListRow(t) {
    const priColor = PRIORITY_COLORS[t.priority] || '#9ca3af';
    const tr = document.createElement('tr');
    tr.className = 'tasks-table-row';
    tr.dataset.id = t.id;
    tr.addEventListener('click', () => openTaskModal(t));

    // Title cell
    const tdTitle = document.createElement('td');
    const dot = document.createElement('span');
    dot.className = 'list-priority-dot';
    dot.style.background = priColor;
    tdTitle.appendChild(dot);
    tdTitle.appendChild(document.createTextNode(' ' + t.title));
    tr.appendChild(tdTitle);

    // Status cell
    const tdStatus = document.createElement('td');
    const sel = document.createElement('select');
    sel.className = 'list-status-select';
    sel.dataset.id = t.id;
    STATUSES.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.key;
      opt.textContent = s.label;
      if (t.status === s.key) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', async e => {
      try {
        await api().updateTask(t.id, { status: e.target.value });
        t.status = e.target.value;
        render();
      } catch (err) { console.error(err); }
    });
    tdStatus.appendChild(sel);
    tr.appendChild(tdStatus);

    // Priority cell
    const tdPri = document.createElement('td');
    const priBadge = document.createElement('span');
    priBadge.className = 'list-priority-badge';
    priBadge.style.color = priColor;
    priBadge.textContent = PRIORITIES[t.priority] || 'None';
    tdPri.appendChild(priBadge);
    tr.appendChild(tdPri);

    // Due date cell
    const tdDue = document.createElement('td');
    if (isOverdue(t)) tdDue.className = 'overdue';
    tdDue.textContent = t.due_date ? formatDate(t.due_date) : '\u2014';
    tr.appendChild(tdDue);

    // Labels cell
    const tdLabels = document.createElement('td');
    if (t.labels && t.labels.length > 0) {
      t.labels.forEach(l => {
        const chip = document.createElement('span');
        chip.className = 'task-label-chip';
        chip.style.background = l.color;
        chip.textContent = l.name;
        tdLabels.appendChild(chip);
      });
    } else {
      tdLabels.textContent = '\u2014';
    }
    tr.appendChild(tdLabels);

    return tr;
  }

  // ==================== MODAL ====================
  function openTaskModal(task, prefillDate) {
    const modal = $('taskModal');
    if (!modal) return;

    const isEdit = !!task;
    $('taskModalTitle').textContent = isEdit ? 'Edit Task' : 'New Task';
    $('taskModalId').value = isEdit ? task.id : '';
    $('taskModalTitleInput').value = isEdit ? task.title : '';
    $('taskModalDesc').value = isEdit ? (task.description || '') : '';
    $('taskModalStatus').value = isEdit ? task.status : 'todo';
    $('taskModalPriority').value = isEdit ? task.priority : 3;

    if (isEdit && task.due_date) {
      $('taskModalDue').value = task.due_date.substring(0, 16);
    } else if (prefillDate) {
      $('taskModalDue').value = prefillDate + 'T09:00';
    } else {
      $('taskModalDue').value = '';
    }

    $('taskModalDeleteBtn')?.classList.toggle('hidden', !isEdit);

    // Render label checkboxes using safe DOM methods
    const labelsContainer = $('taskModalLabels');
    if (labelsContainer) {
      labelsContainer.textContent = '';
      const taskLabelIds = isEdit ? (task.labels || []).map(l => l.id) : [];

      if (labels.length === 0) {
        const noLabels = document.createElement('span');
        noLabels.className = 'tasks-no-labels';
        noLabels.textContent = 'No labels created yet';
        labelsContainer.appendChild(noLabels);
      } else {
        labels.forEach(l => {
          const lbl = document.createElement('label');
          lbl.className = 'tasks-label-checkbox';

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = l.id;
          cb.checked = taskLabelIds.includes(l.id);

          const chip = document.createElement('span');
          chip.className = 'task-label-chip';
          chip.style.background = l.color;
          chip.textContent = l.name;

          lbl.appendChild(cb);
          lbl.appendChild(chip);
          labelsContainer.appendChild(lbl);
        });
      }
    }

    modal.classList.remove('hidden');
    $('taskModalTitleInput')?.focus();
  }

  function closeTaskModal() {
    $('taskModal')?.classList.add('hidden');
  }

  async function saveTask() {
    const titleInput = $('taskModalTitleInput');
    const title = titleInput?.value.trim();
    if (!title) {
      titleInput?.focus();
      return;
    }

    const taskId = $('taskModalId')?.value;
    const isEdit = !!taskId;

    const data = {
      title,
      description: $('taskModalDesc')?.value || '',
      status: $('taskModalStatus')?.value || 'todo',
      priority: Number($('taskModalPriority')?.value) || 3,
      dueDate: $('taskModalDue')?.value || null
    };

    // Selected label IDs from checkboxes
    const selectedLabelIds = [];
    $('taskModalLabels')?.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
      selectedLabelIds.push(cb.value);
    });

    try {
      let savedTask;
      if (isEdit) {
        savedTask = await api().updateTask(taskId, data);
        // Sync labels
        const oldLabelIds = (tasks.find(t => t.id === taskId)?.labels || []).map(l => l.id);
        const toAdd = selectedLabelIds.filter(id => !oldLabelIds.includes(id));
        const toRemove = oldLabelIds.filter(id => !selectedLabelIds.includes(id));
        await Promise.all([
          ...toAdd.map(lid => api().assignTaskLabel(taskId, lid)),
          ...toRemove.map(lid => api().removeTaskLabel(taskId, lid))
        ]);
      } else {
        savedTask = await api().createTask(data);
        if (selectedLabelIds.length > 0) {
          await Promise.all(selectedLabelIds.map(lid => api().assignTaskLabel(savedTask.id, lid)));
        }
      }
      closeTaskModal();
      await load();
    } catch (err) {
      console.error('Save task failed:', err);
    }
  }

  async function deleteCurrentTask() {
    const taskId = $('taskModalId')?.value;
    if (!taskId) return;
    if (!confirm('Delete this task?')) return;

    try {
      await api().deleteTask(taskId);
      closeTaskModal();
      await load();
    } catch (err) {
      console.error('Delete task failed:', err);
    }
  }

  // ==================== HELPERS ====================
  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function formatISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function isOverdue(task) {
    if (!task.due_date || task.status === 'done' || task.status === 'cancelled') return false;
    return new Date(task.due_date) < new Date();
  }

  // ==================== PUBLIC ====================
  window.tasksView = { load };
})();
