const { useEffect, useMemo, useRef, useState, useCallback } = React;

/**
 * Simple ERP – Inventory-Only (Browser, No Server)
 * ------------------------------------------------------------------
 * Fixes:
 *  - Repaired broken regex/string literals that caused `Unterminated regular expression`.
 *  - Removed duplicate file content.
 *  - Added a small self-test runner to validate helpers and export logic.
 *
 * Features:
 *  - Matches your DETAIL INVENTORY layout.
 *  - Front columns: FABRIC, BOX, PALLET, LABEL, STYLE, COLOR, SIZE, SKU, LOCATION,
 *    then dynamic REF__CHANNEL columns, plus TOTAL_IN, TOTAL_OUT, BALANCE.
 *  - Runs offline using localStorage. No server required.
 */

/** ----------------------------- Persistence ----------------------------- */
const STORAGE_KEY = "simple_erp_inventory_v3";
const loadState = () => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { products: [], locations: [], movements: [] };
        const s = JSON.parse(raw);
        return { products: s.products || [], locations: s.locations || [], movements: s.movements || [] };
    } catch {
        return { products: [], locations: [], movements: [] };
    }
};
const saveState = (s) => localStorage.setItem(STORAGE_KEY, JSON.stringify(s));

/** ------------------------------- Helpers ------------------------------- */
const uid = (p = "id") => `${p}_${Math.random().toString(36).slice(2, 9)}`;

/** CSV helpers */
const toCSV = (rows, headers) => {
    const esc = (v) => {
        const s = `${v ?? ""}`;
        // Escape if contains quote, comma, or newline
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
};
const download = (name, content, mime = "text/csv;charset=utf-8;") => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
};

/** Map movement (type + chosen channel) to IN/OUT bucket */
const channelLabel = (type, channel) => {
    if (channel && channel !== "AUTO") return channel;
    if (type === "RECEIPT" || type === "TRANSFER_IN") return "IN";
    if (type === "SALE" || type === "TRANSFER_OUT") return "OUT - OTHER";
    if (type === "ADJUST") return "IN"; // sign handled by qty
    return "IN";
};

/** Build the DETAIL INVENTORY table (pure function for tests/export) */
function buildDetailInventory(state) {
    const pBySKU = new Map(state.products.map((p) => [p.sku, p]));
    const rows = state.movements.map((m) => {
        const p = pBySKU.get(m.sku) || {
            style: "",
            color: "",
            size: "",
            fabric: "",
            box: "",
            pallet: "",
            label: "",
        };
        const bucket = channelLabel(m.type, m.channel);
        const ref = m.ref && m.ref.trim() ? m.ref.trim() : bucket;
        const col = `${ref}__${bucket}`; // e.g., 452__OUT - FBA
        return {
            sku: m.sku,
            style: p.style,
            color: p.color,
            size: p.size,
            fabric: p.fabric || "",
            box: p.box || "",
            pallet: p.pallet || "",
            label: p.label || "",
            location: m.location,
            col,
            qty: Number(m.qty || 0),
        };
    });
    // Aggregate per sku/attrs/location/col
    const key = (o) => [o.sku, o.style, o.color, o.size, o.fabric, o.box, o.pallet, o.label, o.location, o.col].join("@@");
    const agg = new Map();
    for (const r of rows) {
        const k = key(r);
        agg.set(k, (agg.get(k) || 0) + r.qty);
    }
    // Build grid
    const all = Array.from(agg.entries()).map(([k, v]) => {
        const [sku, style, color, size, fabric, box, pallet, label, location, col] = k.split("@@");
        return { sku, style, color, size, fabric, box, pallet, label, location, col, qty: v };
    });
    const byKey = new Map();
    for (const r of all) {
        const id = [r.sku, r.style, r.color, r.size, r.fabric, r.box, r.pallet, r.label, r.location].join("@@");
        if (!byKey.has(id))
            byKey.set(id, {
                sku: r.sku,
                style: r.style,
                color: r.color,
                size: r.size,
                fabric: r.fabric,
                box: r.box,
                pallet: r.pallet,
                label: r.label,
                location: r.location,
            });
        const row = byKey.get(id);
        row[r.col] = (row[r.col] || 0) + r.qty;
    }
    const outRows = Array.from(byKey.values());
    // Totals
    for (const r of outRows) {
        const cols = Object.keys(r).filter((k) => k.includes("__"));
        const tin = cols.filter((c) => c.endsWith("__IN"));
        const tout = cols.filter((c) => c.includes("__OUT"));
        r.TOTAL_IN = tin.reduce((s, c) => s + Number(r[c] || 0), 0);
        r.TOTAL_OUT = tout.reduce((s, c) => s + Number(r[c] || 0), 0);
        r.BALANCE = r.TOTAL_IN + r.TOTAL_OUT; // OUT is already negative
    }
    const front = [
        "fabric",
        "box",
        "pallet",
        "label",
        "style",
        "color",
        "size",
        "sku",
        "location",
        "TOTAL_IN",
        "TOTAL_OUT",
        "BALANCE",
    ];
    const dyn = Array.from(new Set(outRows.flatMap((r) => Object.keys(r).filter((k) => k.includes("__"))))).sort();
    const headers = [...front, ...dyn];
    const csv = toCSV(outRows, headers);
    return { headers, rows: outRows, csv };
}

/** ------------------------------ UI Building ---------------------------- */
const Section = ({ title, actions, children }) => (
    <div className="bg-white rounded-2xl shadow p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-semibold">{title}</h2>
            <div className="flex gap-2 overflow-x-auto pb-2">
                <div className="flex flex-nowrap gap-2 min-w-max">
                    {actions}
                </div>
            </div>
        </div>
        {children}
    </div>
);
const ToolbarButton = ({ onClick, children, title }) => (
    <button onClick={onClick} title={title} className="rounded-2xl border px-3 py-2 hover:bg-gray-50 active:scale-[0.98]">
        {children}
    </button>
);
const TextInput = ({ label, value, onChange, placeholder, required, className }) => (
    <label className={`block ${className || ""}`}>
        <span className="text-sm text-gray-700">{label}</span>
        <input
            className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-black/10"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            required={required}
        />
    </label>
);
const NumberInput = ({ label, value, onChange, min = 0, className }) => (
    <label className={`block ${className || ""}`}>
        <span className="text-sm text-gray-700">{label}</span>
        <input
            type="number"
            className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-black/10"
            value={value}
            min={min}
            onChange={(e) => onChange(Number(e.target.value))}
        />
    </label>
);
const Select = ({ label, value, onChange, options, className }) => (
    <label className={`block ${className || ""}`}>
        <span className="text-sm text-gray-700">{label}</span>
        <select
            className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-black/10"
            value={value}
            onChange={(e) => onChange(e.target.value)}
        >
            {options.map((o) => (
                <option key={o.value} value={o.value}>
                    {o.label}
                </option>
            ))}
        </select>
    </label>
);
const Pill = ({ children }) => (
    <span className="inline-block rounded-full border px-2 py-0.5 text-xs text-gray-700">{children}</span>
);

/** ---------------------------------- App -------------------------------- */
function App() {
    const [state, setState] = useState(loadState());
    const [tab, setTab] = useState("stock");
    const [query, setQuery] = useState("");
    const [sortConfig, setSortConfig] = useState({ key: null, direction: 'asc' });
    const [editingRowKey, setEditingRowKey] = useState(null);
    const [duplicateModal, setDuplicateModal] = useState({ show: false, duplicates: [], onResolve: null });

    useEffect(() => saveState(state), [state]);

    // ---------- Derived stock by SKU x Location ----------
    const stockRows = useMemo(() => {
        const byKey = new Map();
        const pBySKU = new Map(state.products.map((p) => [p.sku, p]));

        // Debug logging
        console.log('Stock calculation - Products:', state.products.length, 'Movements:', state.movements.length);
        if (state.products.some(p => p.sku.startsWith('MERGED_'))) {
            console.log('Found merged products:', state.products.filter(p => p.sku.startsWith('MERGED_')));
        }
        if (state.movements.some(m => m.sku.startsWith('MERGED_'))) {
            console.log('Found merged movements:', state.movements.filter(m => m.sku.startsWith('MERGED_')));
        }

        // Calculate current inventory: Baseline Inventory - Sales = Current Stock
        for (const m of state.movements) {
            if (!pBySKU.has(m.sku)) {
                console.log('Movement SKU not found in products:', m.sku);
                continue;
            }

            // Handle undefined location
            const location = m.location || "Unknown Location";
            const key = `${m.sku}@@${location}`;
            const prev = byKey.get(key) || 0;
            let delta = Number(m.qty || 0);

            // Handle different movement types
            if (m.type === 'RECEIPT' || m.type === 'TRANSFER_IN') {
                delta = delta; // Positive
            } else if (m.type === 'SALE' || m.type === 'TRANSFER_OUT') {
                delta = -delta; // Negative
            } else if (m.type === 'ADJUSTMENT') {
                delta = delta; // Can be positive or negative
            }
            // RECEIPT (positive) - SALE (negative) + ADJUSTMENT = remaining stock
            byKey.set(key, prev + delta);
            if (m.sku.startsWith('MERGED_')) {
                console.log('Merged movement processed:', { sku: m.sku, location: location, qty: m.qty, delta, newTotal: prev + delta });
            }
        }

        const rows = [];
        for (const [k, qty] of byKey) {
            // Show all items (including negative and zero)
            const [sku, location] = k.split("@@");
            const p = pBySKU.get(sku);
            if (!p) {
                console.log('Product not found for SKU:', sku);
                continue;
            }
            const row = {
                sku,
                style: p.style,
                color: p.color,
                size: p.size,
                location,
                qty: qty, // Show actual quantity (can be negative, zero, or positive)
                fabric: p.fabric || "",
                box: p.box || "",
                pallet: p.pallet || "",
                label: p.label || "",
            };

            // Debug logging for merged items
            if (sku.startsWith('MERGED_')) {
                console.log('Creating stock row for merged item:', { sku, location, qty, type: typeof qty });
            }

            rows.push(row);
        }

        const mergedRows = rows.filter(r => r.sku.startsWith('MERGED_'));
        if (mergedRows.length > 0) {
            console.log('Merged items in final stock rows:', mergedRows);
        }
        return rows.sort((a, b) => (a.sku + a.location).localeCompare(b.sku + b.location));
    }, [state.products, state.movements]);

    // Calculate outgoing movements for date range
    const [dateRange, setDateRange] = useState({
        startDate: new Date().toISOString().split('T')[0], // Today
        endDate: new Date().toISOString().split('T')[0]   // Today
    });

    const outgoingMovements = useMemo(() => {
        const start = new Date(dateRange.startDate);
        const end = new Date(dateRange.endDate);
        end.setHours(23, 59, 59, 999); // End of day

        return state.movements
            .filter(m => {
                const moveDate = new Date(m.ts);
                return moveDate >= start && moveDate <= end && m.qty < 0; // Outgoing movements only
            })
            .sort((a, b) => new Date(b.ts) - new Date(a.ts)); // Most recent first
    }, [state.movements, dateRange]);

    const outgoingSummary = useMemo(() => {
        const summary = {
            totalMovements: outgoingMovements.length,
            totalUnits: outgoingMovements.reduce((sum, m) => sum + Math.abs(m.qty), 0),
            byType: {},
            byLocation: {},
            byChannel: {}
        };

        outgoingMovements.forEach(m => {
            // By type
            summary.byType[m.type] = (summary.byType[m.type] || 0) + Math.abs(m.qty);

            // By location
            summary.byLocation[m.location] = (summary.byLocation[m.location] || 0) + Math.abs(m.qty);

            // By channel
            summary.byChannel[m.channel] = (summary.byChannel[m.channel] || 0) + Math.abs(m.qty);
        });

        return summary;
    }, [outgoingMovements]);

    const filteredStock = useMemo(() => {
        let filtered = stockRows;

        // Apply search filter
        if (query.trim()) {
            const q = query.toLowerCase();
            filtered = stockRows.filter((r) =>
                [r.sku, r.style, r.color, r.size, r.location, r.fabric, r.box, r.pallet, r.label]
                    .some((x) => `${x}`.toLowerCase().includes(q))
            );
        }

        // Apply sorting
        if (sortConfig.key) {
            filtered = [...filtered].sort((a, b) => {
                let aVal = a[sortConfig.key];
                let bVal = b[sortConfig.key];

                // Handle numeric values
                if (sortConfig.key === 'qty') {
                    aVal = Number(aVal) || 0;
                    bVal = Number(bVal) || 0;
                } else {
                    // Handle string values
                    aVal = String(aVal || '').toLowerCase();
                    bVal = String(bVal || '').toLowerCase();
                }

                if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
                if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
                return 0;
            });
        }

        return filtered;
    }, [stockRows, query, sortConfig]);

    // ---------------- Products ----------------
    const upsertProduct = (p) =>
        setState((s) => {
            const i = s.products.findIndex((x) => x.sku === p.sku);
            const products = [...s.products];
            if (i >= 0) products[i] = { ...products[i], ...p };
            else products.push({ id: uid("prod"), ...p });
            return { ...s, products };
        });
    const removeProduct = (sku) =>
        setState((s) => ({ ...s, products: s.products.filter((p) => p.sku !== sku) }));

    // ---------------- Locations ---------------
    const ensureLocation = (name) =>
        setState((s) => (s.locations.some((l) => l.name === name) ? s : { ...s, locations: [...s.locations, { id: uid("loc"), name }] }));
    const removeLocation = (name) =>
        setState((s) => ({ ...s, locations: s.locations.filter((l) => l.name !== name) }));

    // ---------------- Movements ---------------
    const addMovement = ({ type, sku, location, qty, ref = "", note = "", channel = "AUTO", ts = new Date().toISOString() }) =>
        setState((s) => ({
            ...s,
            movements: [...s.movements, { id: uid("mv"), type, sku, location, qty: Number(qty), ref, note, channel, ts }],
        }));
    const transferMovement = ({ sku, from, to, qty, ref = "", note = "" }) =>
        setState((s) => {
            const ts = new Date().toISOString();
            return {
                ...s,
                movements: [
                    ...s.movements,
                    { id: uid("mv"), type: "TRANSFER_OUT", sku, location: from, qty: -Math.abs(Number(qty)), ref, note, channel: "OUT - OTHER", ts },
                    { id: uid("mv"), type: "TRANSFER_IN", sku, location: to, qty: Math.abs(Number(qty)), ref, note, channel: "IN", ts },
                ],
            };
        });
    const clearAll = () => {
        if (confirm("Erase ALL local data?")) {
            const empty = { products: [], locations: [], movements: [] };
            setState(empty);
            saveState(empty);
        }
    };

    // Sorting function
    const handleSort = (key) => {
        setSortConfig(prev => ({
            key,
            direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
        }));
    };

    // Inline editing functions
    const startEditing = (sku, location) => {
        const rowKey = `${sku}@@${location}`;
        console.log('Starting edit for row:', rowKey);
        setEditingRowKey(rowKey);
    };

    const cancelEditing = () => {
        setEditingRowKey(null);
    };

    const saveEditing = (sku, location, updatedData = {}) => {
        const rowKey = `${sku}@@${location}`;
        console.log('Saving row:', rowKey, updatedData);
        if (!updatedData || Object.keys(updatedData).length === 0) {
            setEditingRowKey(null);
            return;
        }
        setState(prev => {
            let updatedProducts = [...prev.products];
            let updatedMovements = [...prev.movements];
            let updatedLocations = prev.locations;

            const productFieldWhitelist = new Set(["style", "color", "size", "fabric", "box", "pallet", "label", "description"]);
            const productUpdates = Object.fromEntries(
                Object.entries(updatedData).filter(([key]) => productFieldWhitelist.has(key))
            );
            if (Object.keys(productUpdates).length > 0) {
                updatedProducts = updatedProducts.map(p =>
                    p.sku === sku ? { ...p, ...productUpdates } : p
                );
            }

            // Handle special cases for location and quantity
            if (updatedData.location !== undefined) {
                const nextLocation = String(updatedData.location).trim();
                if (nextLocation && nextLocation !== location) {
                    updatedMovements = updatedMovements.map(m =>
                        m.sku === sku && m.location === location ? { ...m, location: nextLocation } : m
                    );
                    if (!prev.locations.some(l => l.name === nextLocation)) {
                        updatedLocations = [...prev.locations, { id: uid("loc"), name: nextLocation }];
                    }
                    console.log('Updated location for movements:', { sku, from: location, to: nextLocation });
                }
            }

            if (updatedData.qty !== undefined) {
                // For quantity changes, we need to add a new ADJUSTMENT movement
                const newQty = Number(updatedData.qty);
                if (!Number.isNaN(newQty)) {
                    const currentRow = stockRows.find(r => r.sku === sku && r.location === location);
                    const currentQty = Number(currentRow?.qty || 0);
                    const qtyDifference = newQty - currentQty;

                    if (qtyDifference !== 0) {
                        const adjustmentMovement = {
                            id: uid("mv"),
                            type: "ADJUSTMENT",
                            sku,
                            location,
                            qty: qtyDifference,
                            ref: "MANUAL_EDIT",
                            note: `Manual quantity adjustment: ${currentQty} → ${newQty}`,
                            channel: qtyDifference > 0 ? "IN" : "OUT",
                            ts: new Date().toISOString()
                        };
                        updatedMovements.push(adjustmentMovement);
                        console.log('Added adjustment movement:', adjustmentMovement);
                    }
                }
            }

            console.log('Updated products:', updatedProducts);
            console.log('Updated movements:', updatedMovements);

            return {
                ...prev,
                products: updatedProducts,
                movements: updatedMovements,
                locations: updatedLocations
            };
        });

        setEditingRowKey(null);
    };

    // Duplicate detection and merging
    const detectAndMergeDuplicates = () => {
        console.log('Detecting duplicates...');
        console.log('Current products:', state.products);

        const duplicates = [];
        const processed = new Set();

        // Group by Style + Color + Size
        const groups = {};
        state.products.forEach(product => {
            const key = `${product.style}${product.color}${product.size}`;
            if (!groups[key]) {
                groups[key] = [];
            }
            groups[key].push(product);
        });

        console.log('Grouped products:', groups);

        // Find groups with multiple items
        Object.entries(groups).forEach(([key, items]) => {
            console.log('Checking group:', key, 'with items:', items);
            if (items.length > 1) {
                const uniqueSkus = new Set(items.map(item => item.sku));
                const uniqueLocations = new Set(items.map(item => item.location));

                console.log('Unique SKUs:', Array.from(uniqueSkus));
                console.log('Unique Locations:', Array.from(uniqueLocations));

                // Only show modal if there are different SKUs or locations
                if (uniqueSkus.size > 1 || uniqueLocations.size > 1) {
                    // Calculate quantities for each item
                    const itemsWithQuantities = items.map(item => {
                        const movementsForSku = state.movements.filter(m => m.sku === item.sku);
                        const totalQty = movementsForSku.reduce((sum, m) => {
                            if (m.type === 'RECEIPT' || m.type === 'TRANSFER_IN') return sum + (m.qty || 0);
                            if (m.type === 'SALE' || m.type === 'TRANSFER_OUT') return sum - (m.qty || 0);
                            return sum + (m.qty || 0);
                        }, 0);
                        return { ...item, qty: totalQty };
                    });

                    const totalQty = itemsWithQuantities.reduce((sum, item) => sum + item.qty, 0);

                    duplicates.push({
                        key,
                        items: itemsWithQuantities,
                        totalQty: totalQty,
                        uniqueSkus: Array.from(uniqueSkus),
                        uniqueLocations: Array.from(uniqueLocations)
                    });
                    console.log('Added duplicate group:', key, 'with total quantity:', totalQty);
                }
            }
        });

        console.log('Found duplicates:', duplicates);

        if (duplicates.length > 0) {
            console.log('Showing duplicate modal with', duplicates.length, 'groups');
            setDuplicateModal({
                show: true,
                duplicates,
                onResolve: (resolutions) => {
                    console.log('Modal resolved with:', resolutions);
                    resolveDuplicates(resolutions);
                    setDuplicateModal({ show: false, duplicates: [], onResolve: null });
                }
            });
        } else {
            console.log('No duplicates found');
            alert('No duplicates found to merge!');
        }
    };

    const resolveDuplicates = (resolutions) => {
        console.log('Resolving duplicates with resolutions:', resolutions);
        setState(prev => {
            let updatedProducts = [...prev.products];
            let updatedMovements = [...prev.movements];

            resolutions.forEach(resolution => {
                const { key, selectedSku, selectedLocation } = resolution;
                // Find the duplicate items from the current state instead of modal state
                const groups = {};
                prev.products.forEach(product => {
                    const groupKey = `${product.style}${product.color}${product.size}`;
                    if (!groups[groupKey]) groups[groupKey] = [];
                    groups[groupKey].push(product);
                });
                const duplicateItems = groups[key] || [];

                console.log('Processing duplicate group:', key, 'with items:', duplicateItems);

                if (duplicateItems.length > 1) {
                    // Get ALL SKUs in the duplicate group (including the selected one)
                    const allSkusInGroup = duplicateItems.map(item => item.sku);
                    console.log('All SKUs to remove:', allSkusInGroup);

                    // Calculate total quantity from movements for these SKUs
                    const movementsForSkus = prev.movements.filter(m => allSkusInGroup.includes(m.sku));
                    const totalQty = movementsForSkus.reduce((sum, m) => {
                        if (m.type === 'RECEIPT' || m.type === 'TRANSFER_IN') return sum + (m.qty || 0);
                        if (m.type === 'SALE' || m.type === 'TRANSFER_OUT') return sum - (m.qty || 0);
                        return sum + (m.qty || 0); // ADJUST type
                    }, 0);
                    console.log('Total quantity to merge:', totalQty);

                    // Remove ALL duplicate products (including the selected one)
                    updatedProducts = updatedProducts.filter(p => !allSkusInGroup.includes(p.sku));
                    console.log('Products after removal:', updatedProducts.length);

                    // Remove ALL movements for ALL SKUs in the group
                    updatedMovements = updatedMovements.filter(m => !allSkusInGroup.includes(m.sku));
                    console.log('Movements after removal:', updatedMovements.length);

                    // Create a completely new product with the selected SKU and location
                    const firstItem = duplicateItems[0]; // Use first item as template
                    const newProduct = {
                        sku: selectedSku,
                        style: firstItem.style,
                        color: firstItem.color,
                        size: firstItem.size,
                        fabric: firstItem.fabric || "N/A",
                        box: firstItem.box || "N/A",
                        pallet: firstItem.pallet || "N/A",
                        label: firstItem.label || "N/A",
                        location: selectedLocation // Use the user-selected location
                    };
                    updatedProducts.push(newProduct);
                    console.log('Created new product with selected location:', newProduct);

                    // Verify no duplicates remain
                    const remainingDuplicates = updatedProducts.filter(p =>
                        p.style === firstItem.style &&
                        p.color === firstItem.color &&
                        p.size === firstItem.size
                    );
                    console.log('Remaining products with same Style+Color+Size:', remainingDuplicates);

                    // Add a new RECEIPT movement for the selected SKU with the calculated total quantity
                    const newMovement = {
                        id: uid("mv"),
                        type: "RECEIPT",
                        sku: selectedSku,
                        location: selectedLocation,
                        qty: Math.max(0, totalQty), // Ensure non-negative
                        ref: "DUPLICATE_MERGE",
                        note: `Merged ${duplicateItems.length} items: ${allSkusInGroup.join(', ')}`,
                        channel: "IN",
                        ts: new Date().toISOString()
                    };

                    // Ensure location is never undefined
                    if (!newMovement.location) {
                        console.warn('Location was undefined, using selected location:', selectedLocation);
                        newMovement.location = selectedLocation || "Unknown Location";
                    }

                    updatedMovements.push(newMovement);
                    console.log('Added new movement:', newMovement);
                }
            });

            console.log('Final state - Products:', updatedProducts.length, 'Movements:', updatedMovements.length);
            const newState = {
                ...prev,
                products: updatedProducts,
                movements: updatedMovements
            };

            // Force immediate state synchronization
            setTimeout(() => {
                console.log('Forcing immediate state sync...');
                const storedState = JSON.parse(localStorage.getItem(STORAGE_KEY));
                if (storedState) {
                    setState(storedState);
                }
            }, 50);

            // Force a refresh of the display
            setTimeout(() => {
                console.log('Forcing display refresh after regular merge...');
                console.log('Checking if merged items exist in new state...');
                const mergedProducts = newState.products.filter(p => p.sku.startsWith('MERGED_'));
                const mergedMovements = newState.movements.filter(m => m.sku.startsWith('MERGED_'));
                console.log('Merged products after merge:', mergedProducts);
                console.log('Merged movements after merge:', mergedMovements);
                setState(prev => ({ ...prev })); // Trigger re-render
            }, 100);

            return newState;
        });
    };

    // Debug function to check current data
    const debugCurrentData = () => {
        console.log('=== DEBUG CURRENT DATA ===');
        console.log('Products:', state.products);
        console.log('Movements:', state.movements);
        console.log('StockRows:', stockRows);

        // Check for duplicates in products
        const groups = {};
        state.products.forEach(product => {
            const key = `${product.style}${product.color}${product.size}`;
            if (!groups[key]) {
                groups[key] = [];
            }
            groups[key].push(product);
        });

        console.log('Product groups by Style+Color+Size:', groups);

        // Find actual duplicates
        const duplicates = [];
        Object.entries(groups).forEach(([key, items]) => {
            if (items.length > 1) {
                const uniqueSkus = new Set(items.map(item => item.sku));
                const uniqueLocations = new Set(items.map(item => item.location));

                if (uniqueSkus.size > 1 || uniqueLocations.size > 1) {
                    duplicates.push({
                        key,
                        items,
                        uniqueSkus: Array.from(uniqueSkus),
                        uniqueLocations: Array.from(uniqueLocations)
                    });
                }
            }
        });

        console.log('Found duplicates:', duplicates);

        if (duplicates.length === 0) {
            alert('No duplicates found in current data!');
        } else {
            alert(`Found ${duplicates.length} duplicate groups! Check console for details.`);
        }
    };

    // Test merge with real data
    const testMergeWithRealData = () => {
        console.log('=== TESTING MERGE WITH REAL DATA ===');

        // Find duplicates in current data
        const groups = {};
        state.products.forEach(product => {
            const key = `${product.style}${product.color}${product.size}`;
            if (!groups[key]) {
                groups[key] = [];
            }
            groups[key].push(product);
        });

        const duplicates = [];
        Object.entries(groups).forEach(([key, items]) => {
            if (items.length > 1) {
                const uniqueSkus = new Set(items.map(item => item.sku));
                const uniqueLocations = new Set(items.map(item => item.location));

                if (uniqueSkus.size > 1 || uniqueLocations.size > 1) {
                    duplicates.push({
                        key,
                        items,
                        uniqueSkus: Array.from(uniqueSkus),
                        uniqueLocations: Array.from(uniqueLocations)
                    });
                }
            }
        });

        if (duplicates.length === 0) {
            alert('No duplicates found to merge!');
            return;
        }

        console.log('Found duplicates to merge:', duplicates);

        // Test merge the first duplicate group
        const firstDuplicate = duplicates[0];
        const skusToRemove = firstDuplicate.items.map(item => item.sku);
        const selectedLocation = firstDuplicate.uniqueLocations[0];

        console.log('Testing merge of:', firstDuplicate.key);
        console.log('SKUs to remove:', skusToRemove);
        console.log('Selected location:', selectedLocation);

        // Calculate total quantity from movements
        const movementsForSkus = state.movements.filter(m => skusToRemove.includes(m.sku));
        const totalQty = movementsForSkus.reduce((sum, m) => {
            if (m.type === 'RECEIPT' || m.type === 'TRANSFER_IN') return sum + (m.qty || 0);
            if (m.type === 'SALE' || m.type === 'TRANSFER_OUT') return sum - (m.qty || 0);
            return sum + (m.qty || 0);
        }, 0);

        console.log('Movements for SKUs:', movementsForSkus);
        console.log('Total quantity:', totalQty);

        // Perform the merge
        setState(prev => {
            let updatedProducts = prev.products.filter(p => !skusToRemove.includes(p.sku));
            let updatedMovements = prev.movements.filter(m => !skusToRemove.includes(m.sku));

            // Create new merged product
            const firstItem = firstDuplicate.items[0];
            const newSku = `MERGED_${uid("sku")}`;

            const newProduct = {
                sku: newSku,
                style: firstItem.style,
                color: firstItem.color,
                size: firstItem.size,
                fabric: firstItem.fabric || "N/A",
                box: firstItem.box || "N/A",
                pallet: firstItem.pallet || "N/A",
                label: firstItem.label || "N/A",
                location: selectedLocation
            };

            updatedProducts.push(newProduct);

            // Add new movement
            const newMovement = {
                id: uid("mv"),
                type: "RECEIPT",
                sku: newSku,
                location: selectedLocation,
                qty: Math.max(0, totalQty),
                ref: "TEST_MERGE",
                note: `Test merge of ${skusToRemove.join(', ')}`,
                channel: "IN",
                ts: new Date().toISOString()
            };

            updatedMovements.push(newMovement);

            console.log('Merge completed!');
            console.log('New product:', newProduct);
            console.log('New movement:', newMovement);
            console.log('Final products count:', updatedProducts.length);
            console.log('Final movements count:', updatedMovements.length);

            return {
                ...prev,
                products: updatedProducts,
                movements: updatedMovements
            };
        });

        alert(`Test merge completed! Check console for details. Merged ${skusToRemove.length} items.`);
    };

    // Simple state test to verify basic functionality
    const simpleStateTest = () => {
        console.log('=== SIMPLE STATE TEST ===');
        console.log('Current state:', state);
        console.log('Products count:', state.products.length);
        console.log('Movements count:', state.movements.length);

        // Test if we can modify state
        setState(prev => {
            console.log('Inside setState, prev state:', prev);
            const newState = {
                ...prev,
                products: [...prev.products, {
                    sku: `TEST_${Date.now()}`,
                    style: "TEST",
                    color: "TEST",
                    size: "TEST",
                    location: "TEST"
                }]
            };
            console.log('New state:', newState);
            return newState;
        });

        alert('Simple state test completed. Check console.');
    };

    // Test function to create duplicates
    const createTestDuplicates = () => {
        console.log('Creating test duplicates...');
        setState(prev => {
            const testProducts = [
                {
                    sku: "TEST_SKU_1",
                    style: "ABC123",
                    color: "Red",
                    size: "M",
                    fabric: "Cotton",
                    box: "Box1",
                    pallet: "Pallet1",
                    label: "Label1",
                    location: "Warehouse1"
                },
                {
                    sku: "TEST_SKU_2",
                    style: "ABC123",
                    color: "Red",
                    size: "M",
                    fabric: "Cotton",
                    box: "Box2",
                    pallet: "Pallet2",
                    label: "Label2",
                    location: "Warehouse2"
                },
                {
                    sku: "TEST_SKU_3",
                    style: "XYZ789",
                    color: "Blue",
                    size: "L",
                    fabric: "Polyester",
                    box: "Box3",
                    pallet: "Pallet3",
                    label: "Label3",
                    location: "Warehouse1"
                },
                {
                    sku: "TEST_SKU_4",
                    style: "XYZ789",
                    color: "Blue",
                    size: "L",
                    fabric: "Polyester",
                    box: "Box4",
                    pallet: "Pallet4",
                    label: "Label4",
                    location: "Warehouse3"
                }
            ];

            const testMovements = [
                {
                    id: uid("mv"),
                    type: "RECEIPT",
                    sku: "TEST_SKU_1",
                    location: "Warehouse1",
                    qty: 10,
                    ref: "TEST",
                    note: "Test duplicate 1",
                    channel: "IN",
                    ts: new Date().toISOString()
                },
                {
                    id: uid("mv"),
                    type: "RECEIPT",
                    sku: "TEST_SKU_2",
                    location: "Warehouse2",
                    qty: 15,
                    ref: "TEST",
                    note: "Test duplicate 2",
                    channel: "IN",
                    ts: new Date().toISOString()
                },
                {
                    id: uid("mv"),
                    type: "RECEIPT",
                    sku: "TEST_SKU_3",
                    location: "Warehouse1",
                    qty: 20,
                    ref: "TEST",
                    note: "Test duplicate 3",
                    channel: "IN",
                    ts: new Date().toISOString()
                },
                {
                    id: uid("mv"),
                    type: "RECEIPT",
                    sku: "TEST_SKU_4",
                    location: "Warehouse3",
                    qty: 25,
                    ref: "TEST",
                    note: "Test duplicate 4",
                    channel: "IN",
                    ts: new Date().toISOString()
                }
            ];

            console.log('Created test data - Products:', testProducts.length, 'Movements:', testMovements.length);
            return {
                ...prev,
                products: testProducts,
                movements: testMovements
            };
        });
    };

    // ---------------- Export: DETAIL INVENTORY (SKU × LOCATION) ----------------
    const exportDETAIL = () => {
        const { csv } = buildDetailInventory(state);
        download(`DETAIL_INVENTORY_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`, csv);
    };

    // ------------------------------ Forms ------------------------------
    const ProductsManager = () => {
        const [sku, setSku] = useState("");
        const [style, setStyle] = useState("");
        const [color, setColor] = useState("");
        const [size, setSize] = useState("");
        const [desc, setDesc] = useState("");
        const [fabric, setFabric] = useState("");
        const [box, setBox] = useState("");
        const [pallet, setPallet] = useState("");
        const [label, setLabel] = useState("");

        const add = () => {
            if (!sku.trim()) return;
            upsertProduct({ sku: sku.trim(), style, color, size, description: desc, fabric, box, pallet, label });
            setSku("");
            setStyle("");
            setColor("");
            setSize("");
            setDesc("");
            setFabric("");
            setBox("");
            setPallet("");
            setLabel("");
        };

        const exportProducts = () => {
            const headers = ["sku", "style", "color", "size", "description", "fabric", "box", "pallet", "label"];
            download(`products_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`, toCSV(state.products, headers));
        };

        return (
            <Section title="Products" actions={<ToolbarButton onClick={exportProducts}>Export CSV</ToolbarButton>}>
                <div className="grid grid-cols-1 md:grid-cols-8 gap-3">
                    <TextInput label="SKU" value={sku} onChange={setSku} placeholder="50372Navy10" required />
                    <TextInput label="Style" value={style} onChange={setStyle} placeholder="50372" />
                    <TextInput label="Color" value={color} onChange={setColor} placeholder="Navy" />
                    <TextInput label="Size" value={size} onChange={setSize} placeholder="10" />
                    <TextInput label="Fabric" value={fabric} onChange={setFabric} placeholder="(optional)" />
                    <TextInput label="Box" value={box} onChange={setBox} placeholder="(optional)" />
                    <TextInput label="Pallet" value={pallet} onChange={setPallet} placeholder="(optional)" />
                    <TextInput label="Label" value={label} onChange={setLabel} placeholder="(optional)" />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                    <TextInput label="Description" value={desc} onChange={setDesc} placeholder="Capri Pants" />
                </div>
                <div className="mt-3 flex gap-2">
                    <button className="rounded-2xl bg-black text-white px-4 py-2" onClick={add}>
                        Add / Update
                    </button>
                </div>

                <div className="mt-4 overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead>
                            <tr className="text-left text-gray-600">
                                <th className="py-2 pr-4">SKU</th>
                                <th className="py-2 pr-4">Style</th>
                                <th className="py-2 pr-4">Color</th>
                                <th className="py-2 pr-4">Size</th>
                                <th className="py-2 pr-4">Fabric</th>
                                <th className="py-2 pr-4">Box</th>
                                <th className="py-2 pr-4">Pallet</th>
                                <th className="py-2 pr-4">Label</th>
                                <th className="py-2 pr-4">Description</th>
                                <th className="py-2 pr-4">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {state.products.map((p) => (
                                <tr key={p.id} className="border-t">
                                    <td className="py-2 pr-4 font-medium">{p.sku}</td>
                                    <td className="py-2 pr-4">{p.style}</td>
                                    <td className="py-2 pr-4">{p.color}</td>
                                    <td className="py-2 pr-4">{p.size}</td>
                                    <td className="py-2 pr-4">{p.fabric}</td>
                                    <td className="py-2 pr-4">{p.box}</td>
                                    <td className="py-2 pr-4">{p.pallet}</td>
                                    <td className="py-2 pr-4">{p.label}</td>
                                    <td className="py-2 pr-4">{p.description}</td>
                                    <td className="py-2 pr-4">
                                        <button className="text-red-600 hover:underline" onClick={() => removeProduct(p.sku)}>
                                            Delete
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Section>
        );
    };

    const LocationsManager = () => {
        const [name, setName] = useState("");
        return (
            <Section title="Locations">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <TextInput label="Location Name" value={name} onChange={setName} placeholder="Main Warehouse" />
                </div>
                <div className="mt-3 flex gap-2">
                    <button className="rounded-2xl bg-black text-white px-4 py-2" onClick={() => name.trim() && ensureLocation(name.trim())}>
                        Add
                    </button>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                    {state.locations.map((l) => (
                        <div key={l.id} className="flex items-center gap-2 rounded-xl border px-3 py-2">
                            <span>{l.name}</span>
                            <button className="text-red-600 hover:underline" onClick={() => removeLocation(l.name)}>
                                Remove
                            </button>
                        </div>
                    ))}
                </div>
            </Section>
        );
    };

    const MovementsManager = () => {
        const [type, setType] = useState("RECEIPT");
        const [sku, setSku] = useState("");
        const [location, setLocation] = useState("");
        const [qty, setQty] = useState(1);
        const [ref, setRef] = useState("");
        const [note, setNote] = useState("");
        const [channel, setChannel] = useState("AUTO");

        const fileInput = useRef(null);

        const channelOptions = [
            { value: "AUTO", label: "Auto (based on Type)" },
            { value: "IN", label: "IN" },
            { value: "OUT - FBA", label: "OUT - FBA" },
            { value: "OUT - FBM", label: "OUT - FBM" },
            { value: "OUT - SHOPIFY", label: "OUT - SHOPIFY" },
            { value: "OUT - OTHER", label: "OUT - OTHER" },
        ];

        const submit = () => {
            if (!sku.trim() || !location.trim() || !qty) return;
            if (!state.products.some((p) => p.sku === sku.trim()))
                upsertProduct({ sku: sku.trim(), style: "", color: "", size: "", description: "", fabric: "", box: "", pallet: "", label: "" });
            if (!state.locations.some((l) => l.name === location.trim())) ensureLocation(location.trim());
            const signed = type === "SALE" ? -Math.abs(Number(qty)) : Number(qty);
            addMovement({ type, sku: sku.trim(), location: location.trim(), qty: signed, ref, note, channel });
            setQty(1);
            setRef("");
            setNote("");
            setChannel("AUTO");
        };

        // Transfer
        const [tSku, setTSku] = useState("");
        const [from, setFrom] = useState("");
        const [to, setTo] = useState("");
        const [tQty, setTQty] = useState(1);
        const doTransfer = () => {
            if (!tSku.trim() || !from.trim() || !to.trim() || !tQty) return;
            if (!state.products.some((p) => p.sku === tSku.trim()))
                upsertProduct({ sku: tSku.trim(), style: "", color: "", size: "", description: "", fabric: "", box: "", pallet: "", label: "" });
            if (!state.locations.some((l) => l.name === from.trim())) ensureLocation(from.trim());
            if (!state.locations.some((l) => l.name === to.trim())) ensureLocation(to.trim());
            transferMovement({ sku: tSku.trim(), from: from.trim(), to: to.trim(), qty: tQty });
            setTQty(1);
        };

        // CSV import/export for movements
        const exportMovementsCSV = () => {
            const headers = ["type", "sku", "location", "qty", "ref", "note", "channel", "ts"];
            download(`movements_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`, toCSV(state.movements, headers));
        };
        const importMovementsCSV = (file) => {
            const reader = new FileReader();
            reader.onload = () => {
                const text = String(reader.result || "");
                const lines = text.split(/\r?\n/).filter(Boolean);
                if (!lines.length) return;
                const headers = lines[0].split(",").map((h) => h.trim());
                const next = { ...state };

                // Check if this is your data format (SKU, Style, Color, Size, QTY, Store)
                const isYourFormat = headers.some(h => h === 'SKU') && headers.some(h => h === 'QTY') && headers.some(h => h === 'Store');

                for (let i = 1; i < lines.length; i++) {
                    // CSV parse with quotes support
                    const parts = [];
                    let field = "";
                    let q = false;
                    const line = lines[i];
                    for (let j = 0; j < line.length; j++) {
                        const c = line[j];
                        if (q) {
                            if (c === '"') {
                                if (line[j + 1] === '"') {
                                    field += '"';
                                    j++;
                                } else q = false;
                            } else field += c;
                        } else {
                            if (c === '"') q = true;
                            else if (c === ',') {
                                parts.push(field);
                                field = "";
                            } else field += c;
                        }
                    }
                    parts.push(field);
                    const rec = Object.fromEntries(headers.map((h, k) => [h, (parts[k] ?? "").trim()]));

                    if (isYourFormat) {
                        // Handle your data format: SKU, Style, Color, Size, QTY, Store
                        const sku = rec.SKU || rec.sku;
                        const style = rec.Style || rec.style;
                        const color = rec.Color || rec.color;
                        const size = rec.Size || rec.size;
                        const qty = Number(rec.QTY || rec.qty || 0);
                        const store = rec.Store || rec.store;

                        if (!sku || !store) continue;

                        // Add product if it doesn't exist
                        if (!next.products.some((p) => p.sku === sku)) {
                            next.products.push({
                                id: uid("prod"),
                                sku,
                                style,
                                color,
                                size,
                                description: `${style} ${color} ${size}`.trim(),
                                fabric: "",
                                box: "",
                                pallet: "",
                                label: ""
                            });
                        }

                        // Add location if it doesn't exist
                        if (!next.locations.some((l) => l.name === store)) {
                            next.locations.push({ id: uid("loc"), name: store });
                        }

                        // Add movement to subtract from inventory (like sales/outgoing)
                        if (qty > 0) {
                            next.movements.push({
                                id: uid("mv"),
                                type: "SALE",
                                sku,
                                location: store,
                                qty: -qty, // Negative to subtract from inventory
                                ref: "IMPORT",
                                note: "Imported from data",
                                channel: "OUT - OTHER",
                                ts: new Date().toISOString()
                            });
                        }
                    } else {
                        // Handle standard movements format: type, sku, location, qty, ref, note, channel, ts
                        const sku = rec.sku;
                        const loc = rec.location;
                        if (!sku || !loc) continue;
                        if (!next.products.some((p) => p.sku === sku))
                            next.products.push({ id: uid("prod"), sku, style: "", color: "", size: "", description: "", fabric: "", box: "", pallet: "", label: "" });
                        if (!next.locations.some((l) => l.name === loc)) next.locations.push({ id: uid("loc"), name: loc });
                        const type = (rec.type || "RECEIPT").toUpperCase();
                        const qty = Number(rec.qty || 0);
                        const signed = type === "SALE" ? -Math.abs(qty) : qty;
                        next.movements.push({ id: uid("mv"), type, sku, location: loc, qty: signed, ref: rec.ref || "", note: rec.note || "", channel: rec.channel || "AUTO", ts: rec.ts || new Date().toISOString() });
                    }
                }
                setState(next);
                const importedCount = lines.length - 1;
                if (isYourFormat) {
                    alert(`📦 Daily Movements Imported Successfully!\n\n${importedCount} movements imported.\n\nThese sales/outgoing movements have been subtracted from your inventory.\n\nCheck the Stock tab to see updated inventory levels.`);
                    setTab("stock"); // Switch to stock tab to show updated inventory
                } else {
                    alert(`Imported ${importedCount} movement records successfully!`);
                }
            };
            reader.readAsText(file);
        };

        return (
            <Section
                title="Movements"
                actions={
                    <>
                        <ToolbarButton onClick={exportMovementsCSV}>Export Movements CSV</ToolbarButton>
                        <ToolbarButton onClick={() => fileInput.current?.click()}>Import Movements CSV</ToolbarButton>
                        <input ref={fileInput} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && importMovementsCSV(e.target.files[0])} />
                    </>
                }
            >
                <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
                    <Select label="Type" value={type} onChange={setType} options={[{ value: "RECEIPT", label: "RECEIPT" }, { value: "SALE", label: "SALE" }, { value: "ADJUST", label: "ADJUST (+/–)" }]} />
                    <TextInput label="SKU" value={sku} onChange={setSku} placeholder="50372Navy10" />
                    <TextInput label="Location" value={location} onChange={setLocation} placeholder="Main Warehouse" />
                    <NumberInput label="Qty (signed handled)" value={qty} onChange={setQty} min={1} />
                    <TextInput label="Ref" value={ref} onChange={setRef} placeholder="PO-1001 / AMZ-ORDER-1" />
                    <TextInput label="Note" value={note} onChange={setNote} placeholder="Optional" />
                    <Select label="Channel" value={channel} onChange={setChannel} options={channelOptions} />
                </div>
                <div className="mt-3 flex gap-2">
                    <button className="rounded-2xl bg-black text-white px-4 py-2" onClick={submit}>
                        Add Movement
                    </button>
                    <button className="rounded-2xl border px-4 py-2" onClick={exportDETAIL}>
                        Export DETAIL Inventory
                    </button>
                </div>

                {/* Transfer */}
                <div className="mt-6 p-3 rounded-xl bg-gray-50">
                    <div className="font-medium mb-2">Transfer</div>
                    <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                        <TextInput label="SKU" value={tSku} onChange={setTSku} placeholder="50372Navy10" />
                        <TextInput label="From" value={from} onChange={setFrom} placeholder="Main Warehouse" />
                        <TextInput label="To" value={to} onChange={setTo} placeholder="Overflow" />
                        <NumberInput label="Qty" value={tQty} onChange={setTQty} min={1} />
                    </div>
                    <div className="mt-3 flex gap-2">
                        <button className="rounded-2xl bg-black text-white px-4 py-2" onClick={doTransfer}>
                            Transfer
                        </button>
                    </div>
                </div>

                {/* Ledger */}
                <div className="mt-6 overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead>
                            <tr className="text-left text-gray-600">
                                <th className="py-2 pr-4">Time</th>
                                <th className="py-2 pr-4">Type</th>
                                <th className="py-2 pr-4">Channel</th>
                                <th className="py-2 pr-4">SKU</th>
                                <th className="py-2 pr-4">Location</th>
                                <th className="py-2 pr-4">Qty</th>
                                <th className="py-2 pr-4">Ref</th>
                                <th className="py-2 pr-4">Note</th>
                            </tr>
                        </thead>
                        <tbody>
                            {state.movements
                                .slice()
                                .sort((a, b) => a.ts.localeCompare(b.ts))
                                .map((m) => (
                                    <tr key={m.id} className="border-t">
                                        <td className="py-2 pr-4 whitespace-nowrap">{new Date(m.ts).toLocaleString()}</td>
                                        <td className="py-2 pr-4">
                                            <Pill>{m.type}</Pill>
                                        </td>
                                        <td className="py-2 pr-4">{channelLabel(m.type, m.channel)}</td>
                                        <td className="py-2 pr-4">{m.sku}</td>
                                        <td className="py-2 pr-4">{m.location}</td>
                                        <td className="py-2 pr-4">{m.qty}</td>
                                        <td className="py-2 pr-4">{m.ref}</td>
                                        <td className="py-2 pr-4">{m.note}</td>
                                    </tr>
                                ))}
                        </tbody>
                    </table>
                </div>
            </Section>
        );
    };

    const stockFileInput = useRef(null);

    // Duplicate Resolution Modal
    const DuplicateModal = ({ duplicates, onResolve, onCancel }) => {
        const [resolutions, setResolutions] = useState([]);

        useEffect(() => {
            // Initialize resolutions
            const initialResolutions = duplicates.map(dup => ({
                key: dup.key,
                selectedSku: dup.uniqueSkus[0],
                selectedLocation: dup.uniqueLocations[0]
            }));
            setResolutions(initialResolutions);
        }, [duplicates]);

        const handleResolve = () => {
            onResolve(resolutions);
        };

        return (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                <div className="bg-white rounded-2xl p-6 max-w-4xl max-h-[80vh] overflow-y-auto">
                    <h3 className="text-xl font-semibold mb-4">Merge Duplicate Items</h3>
                    <p className="text-gray-600 mb-4">
                        Found {duplicates.length} groups of duplicate items. Please choose which SKU to keep and the location for each merged item.
                    </p>

                    {duplicates.map((dup, index) => {
                        const resolution = resolutions.find(r => r.key === dup.key);
                        return (
                            <div key={dup.key} className="border rounded-xl p-4 mb-4">
                                <h4 className="font-medium mb-2">
                                    Group {index + 1}: {dup.items[0].style} - {dup.items[0].color} - {dup.items[0].size}
                                </h4>
                                <p className="text-sm text-gray-600 mb-3">
                                    Total Quantity: {dup.totalQty} (sum of {dup.items.length} duplicate items)
                                </p>

                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-medium mb-1">Select SKU to Keep:</label>
                                        <select
                                            value={resolution?.selectedSku || ''}
                                            onChange={(e) => setResolutions(prev =>
                                                prev.map(r => r.key === dup.key
                                                    ? { ...r, selectedSku: e.target.value }
                                                    : r
                                                )
                                            )}
                                            className="w-full border rounded-lg px-3 py-2"
                                        >
                                            {dup.uniqueSkus.map(sku => (
                                                <option key={sku} value={sku}>{sku}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium mb-1">Select Location for Merged Item:</label>
                                        <select
                                            value={resolution?.selectedLocation || ''}
                                            onChange={(e) => setResolutions(prev =>
                                                prev.map(r => r.key === dup.key
                                                    ? { ...r, selectedLocation: e.target.value }
                                                    : r
                                                )
                                            )}
                                            className="w-full border rounded-lg px-3 py-2"
                                        >
                                            {dup.uniqueLocations.map(location => (
                                                <option key={location} value={location}>{location}</option>
                                            ))}
                                        </select>
                                    </div>
                                </div>

                                <div className="mt-3 text-xs text-gray-500">
                                    <strong>Duplicate Items (with individual quantities):</strong>
                                    <ul className="mt-1 space-y-1">
                                        {dup.items.map((item, i) => (
                                            <li key={i} className="flex justify-between">
                                                <span>SKU: {item.sku} | Location: {item.location}</span>
                                                <span className="font-medium text-blue-600">Qty: {item.qty}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </div>
                        );
                    })}

                    <div className="flex gap-3 mt-6">
                        <button
                            onClick={handleResolve}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                        >
                            Merge Duplicates
                        </button>
                        <button
                            onClick={onCancel}
                            className="px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    // Sortable header component
    const SortableHeader = ({ label, sortKey }) => {
        const isActive = sortConfig.key === sortKey;
        const direction = isActive ? sortConfig.direction : null;

        return (
            <div
                className="flex items-center gap-1 cursor-pointer hover:bg-gray-50 select-none"
                onClick={() => handleSort(sortKey)}
            >
                <span className="text-gray-600">{label}</span>
                <div className="flex flex-col">
                    <span className={`text-xs ${isActive && direction === 'asc' ? 'text-blue-600' : 'text-gray-300'}`}>▲</span>
                    <span className={`text-xs ${isActive && direction === 'desc' ? 'text-blue-600' : 'text-gray-300'}`}>▼</span>
                </div>
            </div>
        );
    };

    // Inline editable cell component
    const EditableCell = ({ sku, location, field, value, isEditing, onSave }) => {
        const [editValue, setEditValue] = useState(value);

        // Debug logging
        console.log('EditableCell:', { sku, location, field, value, isEditing, editValue });

        // Update editValue when value prop changes
        useEffect(() => {
            setEditValue(value);
        }, [value]);

        const handleSave = () => {
            if (editValue !== value) {
                onSave(sku, location, { [field]: editValue });
            }
        };

        const handleKeyDown = (e) => {
            if (e.key === 'Enter') {
                handleSave();
            } else if (e.key === 'Escape') {
                setEditValue(value);
                cancelEditing();
            }
        };

        if (isEditing) {
            return (
                <input
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onBlur={handleSave}
                    className="w-full px-2 py-1 border rounded text-sm"
                    autoFocus
                />
            );
        }

        return <span>{value}</span>;
    };

    const StockView = () => {

        // Import stock data with Style, Color, Size, Balance, Box, Location, Pallet, Fabric, Label
        const importStockData = (file) => {
            console.log('File selected:', file.name, 'Size:', file.size);
            const reader = new FileReader();
            reader.onload = () => {
                const text = String(reader.result || "");
                console.log('File content length:', text.length);
                console.log('First 500 characters:', text.substring(0, 500));
                const lines = text.split(/\r?\n/).filter(Boolean);
                console.log('Number of lines:', lines.length);
                if (!lines.length) {
                    console.log('No lines found in file');
                    return;
                }

                const headers = lines[0].split(",").map((h) => h.trim());
                console.log('CSV Headers:', headers);
                let processedRows = 0;
                let skippedRows = 0;

                for (let i = 1; i < lines.length; i++) {
                    const parts = lines[i].split(",").map((p) => p.trim());
                    if (parts.length < headers.length) {
                        console.log('Skipping row - insufficient parts:', parts);
                        continue;
                    }

                    const rec = Object.fromEntries(headers.map((h, k) => [h, parts[k] || ""]));
                    if (i <= 10) { // Log first 10 rows to see what's happening
                        console.log('Row data:', rec);
                        console.log('Headers found:', Object.keys(rec));
                    }

                    // Map stock data format: Style, Color, Size, Balance, Box, Location, Pallet, Fabric, Label
                    const style = rec.STYLE || rec.Style || rec.style || "";
                    const color = rec.COLOR || rec.Color || rec.color || "";
                    const size = rec.SIZE || rec.Size || rec.size || "";
                    const balanceRaw = rec.BALANCE || rec.Balance || rec.balance || "0";
                    const balance = Number(balanceRaw) || 0; // Handle empty, #REF!, and invalid numbers
                    const box = rec.BOX || rec.Box || rec.box || "N/A";
                    const location = rec.LOCATION || rec.Location || rec.location || "Unknown Location";
                    const pallet = rec.PALLET || rec.Pallet || rec.pallet || "N/A";
                    const fabric = rec.FABRIC || rec.Fabric || rec.fabric || "N/A";
                    const label = rec.LABEL || rec.Label || rec.label || "N/A";

                    // Debug the extraction
                    if (i <= 5) {
                        console.log('=== EXTRACTION DEBUG ===');
                        console.log('rec.Style:', rec.Style, 'Type:', typeof rec.Style);
                        console.log('rec.COLOR:', rec.COLOR, 'Type:', typeof rec.COLOR);
                        console.log('rec.SIZE:', rec.SIZE, 'Type:', typeof rec.SIZE);
                        console.log('rec.BALANCE:', rec.BALANCE, 'Type:', typeof rec.BALANCE);
                        console.log('Final extracted style:', style, 'color:', color, 'size:', size, 'balance:', balance);
                    }

                    if (i <= 10) {
                        console.log('Extracted values:', { style, color, size, balance, location });
                        console.log('Style length:', style.length, 'Color length:', color.length);
                        console.log('Style trim:', style.trim(), 'Color trim:', color.trim());
                    }

                    // Only require style and color, everything else can be empty
                    if (!style.trim() || !color.trim()) {
                        if (i <= 10) console.log('Skipping row - missing style or color:', { style, color, size, balance, location });
                        skippedRows++;
                        continue;
                    }

                    // Create SKU from style + color + size
                    const sku = `${style}${color}${size}`.replace(/\s+/g, '');

                    // Debug logging
                    console.log('Importing:', { style, color, size, balance, location, sku });

                    // Add product using upsertProduct function
                    if (i <= 10) console.log('Calling upsertProduct with:', { sku, style, color, size });
                    upsertProduct({
                        sku,
                        style,
                        color,
                        size,
                        description: `${style} ${color} ${size}`.trim(),
                        fabric,
                        box,
                        pallet,
                        label
                    });

                    // Add location using ensureLocation function
                    if (i <= 10) console.log('Calling ensureLocation with:', location);
                    ensureLocation(location);

                    // Add movement using addMovement function
                    if (i <= 10) console.log('Calling addMovement with:', { type: "RECEIPT", sku, location, qty: balance });
                    addMovement({
                        type: "RECEIPT",
                        sku,
                        location,
                        qty: balance, // Can be positive, negative, or zero
                        ref: "STOCK_IMPORT",
                        note: "Imported stock data",
                        channel: "IN"
                    });
                    processedRows++;
                }
                console.log('Import Summary:', { processedRows, skippedRows, totalRows: lines.length - 1 });
                const importedCount = lines.length - 1;
                const validItems = state.products.length;
                const totalUnits = state.movements.filter(m => m.type === "RECEIPT").reduce((sum, m) => sum + m.qty, 0);

                alert(`✅ Total Inventory Imported Successfully!\n\n${importedCount} rows processed\n${validItems} items created\n${totalUnits} total units imported\n\nThis sets your baseline inventory levels.\n\nNow you can import daily movements to track sales/outgoing inventory.`);
                setTab("stock"); // Switch to stock tab to show imported data
            };
            reader.readAsText(file);
        };

        return (
            <Section
                title="Stock by SKU & Location"
                actions={
                    <>
                        <ToolbarButton onClick={() => setQuery("")}>Clear Filter</ToolbarButton>
                        <ToolbarButton
                            onClick={() => {
                                const headers = ["sku", "style", "color", "size", "fabric", "box", "pallet", "label", "location", "qty"];
                                download(`stock_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`, toCSV(stockRows, headers));
                            }}
                        >
                            Export Stock CSV
                        </ToolbarButton>
                        <ToolbarButton onClick={() => stockFileInput.current?.click()}>Import Stock Data</ToolbarButton>
                        <ToolbarButton onClick={detectAndMergeDuplicates}>Merge Duplicates</ToolbarButton>
                        <ToolbarButton onClick={createTestDuplicates}>Create Test Duplicates</ToolbarButton>
                        <ToolbarButton onClick={debugCurrentData}>Debug Current Data</ToolbarButton>
                        <ToolbarButton onClick={testMergeWithRealData}>Test Merge</ToolbarButton>
                        <ToolbarButton onClick={simpleStateTest}>Simple State Test</ToolbarButton>
                        <ToolbarButton onClick={comprehensiveMergeTest}>Comprehensive Merge Test</ToolbarButton>
                        <ToolbarButton onClick={clearAllData}>Clear All Data</ToolbarButton>
                        <ToolbarButton onClick={refreshDisplay}>Refresh Display</ToolbarButton>
                        <ToolbarButton onClick={checkMergedItems}>Check Merged Items</ToolbarButton>
                        <ToolbarButton onClick={diagnoseMergeQuantity}>Diagnose Merge Quantity</ToolbarButton>
                        <ToolbarButton onClick={forceRefreshAndCheck}>Force Refresh & Check</ToolbarButton>
                        <ToolbarButton onClick={debugQuantityDisplay}>Debug Quantity Display</ToolbarButton>
                        <ToolbarButton onClick={testCompleteMergeWorkflow}>Test Complete Workflow</ToolbarButton>
                        <ToolbarButton onClick={checkCurrentStateAndDisplay}>Check State & Display</ToolbarButton>
                        <ToolbarButton onClick={checkAndRestore}>Check & Restore</ToolbarButton>
                        <ToolbarButton onClick={clearAndStartFresh}>Clear & Start Fresh</ToolbarButton>
                        <ToolbarButton onClick={checkStateAfterMerge}>Check After Merge</ToolbarButton>
                        <ToolbarButton onClick={fixMergedMovements}>Fix Merged Movements</ToolbarButton>
                        <ToolbarButton onClick={debugMergedItemsPipeline}>Debug Pipeline</ToolbarButton>
                        <ToolbarButton onClick={createTestMergedItem}>Create Test Merged</ToolbarButton>
                        <ToolbarButton onClick={forceDisplayMergedItems}>Force Display Merged</ToolbarButton>
                        <ToolbarButton onClick={highlightMergedItems}>Highlight Merged</ToolbarButton>
                        <ToolbarButton onClick={checkAndCleanDuplicates}>Clean Duplicates</ToolbarButton>
                        <ToolbarButton onClick={showDuplicateGroups}>Show Duplicates</ToolbarButton>
                        <ToolbarButton onClick={() => {
                            console.log('Current state:', state);
                            console.log('Products:', state.products);
                            console.log('Movements:', state.movements);
                            console.log('Stock rows:', stockRows);
                        }}>Debug State</ToolbarButton>
                        <ToolbarButton onClick={() => {
                            // Add test outgoing movements for today
                            const testOutgoing = [
                                { sku: "6020069NILEPS", location: "Main Warehouse", qty: -5, type: "SALE", channel: "OUT - RETAIL" },
                                { sku: "6020069NILEPM", location: "Main Warehouse", qty: -3, type: "SALE", channel: "OUT - ONLINE" },
                                { sku: "6020069Bachelor ButtonPS", location: "Store A", qty: -2, type: "TRANSFER_OUT", channel: "OUT - OTHER" },
                                { sku: "6020069SilverPL", location: "Store B", qty: -4, type: "SALE", channel: "OUT - WHOLESALE" }
                            ];

                            testOutgoing.forEach(item => {
                                addMovement({
                                    type: item.type,
                                    sku: item.sku,
                                    location: item.location,
                                    qty: item.qty,
                                    ref: "TEST_OUTGOING",
                                    note: "Test outgoing movement",
                                    channel: item.channel
                                });
                            });
                            console.log('Added test outgoing movements');
                        }}>Add Test Outgoing</ToolbarButton>
                        <input ref={stockFileInput} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && importStockData(e.target.files[0])} />
                    </>
                }
            >
                {/* Current Inventory Summary */}
                <div className="mb-6 p-4 bg-blue-50 rounded-2xl border border-blue-200">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-lg font-semibold text-blue-900">📊 Current Inventory Summary</h3>
                        <div className="text-sm text-blue-700">
                            {filteredStock.length} items • {filteredStock.reduce((sum, r) => sum + r.qty, 0)} total units remaining
                        </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
                        <div className="bg-white p-3 rounded-xl border">
                            <div className="font-medium text-gray-700">Items in Stock</div>
                            <div className="text-2xl font-bold text-blue-600">{filteredStock.length}</div>
                        </div>
                        <div className="bg-white p-3 rounded-xl border">
                            <div className="font-medium text-gray-700">Units Remaining</div>
                            <div className="text-2xl font-bold text-green-600">{filteredStock.reduce((sum, r) => sum + r.qty, 0)}</div>
                        </div>
                        <div className="bg-white p-3 rounded-xl border">
                            <div className="font-medium text-gray-700">Locations</div>
                            <div className="text-2xl font-bold text-purple-600">{new Set(filteredStock.map(r => r.location)).size}</div>
                        </div>
                        <div className="bg-white p-3 rounded-xl border">
                            <div className="font-medium text-gray-700">Styles</div>
                            <div className="text-2xl font-bold text-orange-600">{new Set(filteredStock.map(r => r.style)).size}</div>
                        </div>
                    </div>

                    {/* Inventory Breakdown */}
                    <div className="mt-4 p-3 bg-white rounded-xl border">
                        <div className="text-sm font-medium text-gray-700 mb-2">📋 Inventory Calculation</div>
                        <div className="text-xs text-gray-600">
                            <div>• Stock Import: Creates RECEIPT movements (adds to inventory)</div>
                            <div>• Movements Import: Creates SALE movements (subtracts from inventory)</div>
                            <div>• Current Stock = Total Receipts - Total Sales</div>
                            <div>• Only items with remaining stock (qty &gt; 0) are shown</div>
                        </div>
                    </div>
                </div>

                {/* Outgoing Movements Summary */}
                <div className="mb-6 p-4 bg-red-50 rounded-2xl border border-red-200">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-lg font-semibold text-red-900">📤 Outgoing Movements Summary</h3>
                        <div className="flex items-center gap-2">
                            <input
                                type="date"
                                value={dateRange.startDate}
                                onChange={(e) => setDateRange(prev => ({ ...prev, startDate: e.target.value }))}
                                className="px-2 py-1 text-sm border rounded"
                            />
                            <span className="text-red-700">to</span>
                            <input
                                type="date"
                                value={dateRange.endDate}
                                onChange={(e) => setDateRange(prev => ({ ...prev, endDate: e.target.value }))}
                                className="px-2 py-1 text-sm border rounded"
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
                        <div className="bg-white p-3 rounded-xl border">
                            <div className="font-medium text-gray-700">Total Movements</div>
                            <div className="text-2xl font-bold text-red-600">{outgoingSummary.totalMovements}</div>
                        </div>
                        <div className="bg-white p-3 rounded-xl border">
                            <div className="font-medium text-gray-700">Units Out</div>
                            <div className="text-2xl font-bold text-red-600">{outgoingSummary.totalUnits}</div>
                        </div>
                        <div className="bg-white p-3 rounded-xl border">
                            <div className="font-medium text-gray-700">Movement Types</div>
                            <div className="text-2xl font-bold text-orange-600">{Object.keys(outgoingSummary.byType).length}</div>
                        </div>
                        <div className="bg-white p-3 rounded-xl border">
                            <div className="font-medium text-gray-700">Locations</div>
                            <div className="text-2xl font-bold text-purple-600">{Object.keys(outgoingSummary.byLocation).length}</div>
                        </div>
                    </div>

                    {/* Outgoing Movements Breakdown */}
                    {outgoingSummary.totalMovements > 0 && (
                        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                            {/* By Type */}
                            <div className="bg-white p-3 rounded-xl border">
                                <div className="text-sm font-medium text-gray-700 mb-2">By Movement Type</div>
                                {Object.entries(outgoingSummary.byType).map(([type, qty]) => (
                                    <div key={type} className="flex justify-between text-xs">
                                        <span className="text-gray-600">{type}</span>
                                        <span className="font-medium">{qty} units</span>
                                    </div>
                                ))}
                            </div>

                            {/* By Location */}
                            <div className="bg-white p-3 rounded-xl border">
                                <div className="text-sm font-medium text-gray-700 mb-2">By Location</div>
                                {Object.entries(outgoingSummary.byLocation).map(([location, qty]) => (
                                    <div key={location} className="flex justify-between text-xs">
                                        <span className="text-gray-600">{location}</span>
                                        <span className="font-medium">{qty} units</span>
                                    </div>
                                ))}
                            </div>

                            {/* By Channel */}
                            <div className="bg-white p-3 rounded-xl border">
                                <div className="text-sm font-medium text-gray-700 mb-2">By Channel</div>
                                {Object.entries(outgoingSummary.byChannel).map(([channel, qty]) => (
                                    <div key={channel} className="flex justify-between text-xs">
                                        <span className="text-gray-600">{channel}</span>
                                        <span className="font-medium">{qty} units</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Recent Outgoing Movements Table */}
                    {outgoingMovements.length > 0 && (
                        <div className="mt-4 bg-white rounded-xl border overflow-hidden">
                            <div className="px-4 py-3 bg-gray-50 border-b">
                                <h4 className="font-medium text-gray-700">Recent Outgoing Movements</h4>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="min-w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-gray-600">
                                            <th className="py-2 pr-4">Date</th>
                                            <th className="py-2 pr-4">SKU</th>
                                            <th className="py-2 pr-4">Type</th>
                                            <th className="py-2 pr-4">Location</th>
                                            <th className="py-2 pr-4">Qty</th>
                                            <th className="py-2 pr-4">Channel</th>
                                            <th className="py-2 pr-4">Ref</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {outgoingMovements.slice(0, 10).map((m, i) => (
                                            <tr key={i} className="border-t">
                                                <td className="py-2 pr-4 text-xs">{new Date(m.ts).toLocaleDateString()}</td>
                                                <td className="py-2 pr-4 font-medium">{m.sku}</td>
                                                <td className="py-2 pr-4">{m.type}</td>
                                                <td className="py-2 pr-4">{m.location}</td>
                                                <td className="py-2 pr-4 text-red-600">{m.qty}</td>
                                                <td className="py-2 pr-4">{m.channel}</td>
                                                <td className="py-2 pr-4">{m.ref}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </div>

                {/* Inventory Table */}
                <div className="bg-white rounded-2xl border overflow-hidden">
                    <div className="px-4 py-3 bg-gray-50 border-b">
                        <h4 className="font-medium text-gray-700">Current Inventory Levels</h4>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="min-w-full text-sm">
                            <thead>
                                <tr className="text-left text-gray-600">
                                    <th className="py-2 pr-3 w-32"><SortableHeader label="SKU" sortKey="sku" /></th>
                                    <th className="py-2 pr-3 w-24"><SortableHeader label="Style" sortKey="style" /></th>
                                    <th className="py-2 pr-3 w-24"><SortableHeader label="Color" sortKey="color" /></th>
                                    <th className="py-2 pr-3 w-16"><SortableHeader label="Size" sortKey="size" /></th>
                                    <th className="py-2 pr-3 w-32"><SortableHeader label="Fabric" sortKey="fabric" /></th>
                                    <th className="py-2 pr-3 w-20"><SortableHeader label="Box" sortKey="box" /></th>
                                    <th className="py-2 pr-3 w-20"><SortableHeader label="Pallet" sortKey="pallet" /></th>
                                    <th className="py-2 pr-3 w-24"><SortableHeader label="Label" sortKey="label" /></th>
                                    <th className="py-2 pr-3 w-32"><SortableHeader label="Location" sortKey="location" /></th>
                                    <th className="py-2 pr-3 w-16"><SortableHeader label="Qty" sortKey="qty" /></th>
                                    <th className="py-2 pr-3 w-20 text-gray-600">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {/* Debug info */}
                                {filteredStock.length === 0 && (
                                    <tr>
                                        <td colSpan="11" className="text-center py-4 text-gray-500">
                                            No items found. Total stock rows: {stockRows.length}
                                        </td>
                                    </tr>
                                )}
                                {/* Show total count for debugging */}
                                <tr className="bg-gray-50">
                                    <td colSpan="11" className="text-center py-2 text-sm text-gray-600">
                                        Showing {filteredStock.length} of {stockRows.length} total items
                                        {stockRows.filter(r => r.sku.startsWith('MERGED_')).length > 0 &&
                                            ` (${stockRows.filter(r => r.sku.startsWith('MERGED_')).length} merged items)`
                                        }
                                    </td>
                                </tr>
                                {filteredStock.map((r, i) => {
                                    const rowKey = `${r.sku}@@${r.location}`;
                                    const isEditing = editingRowKey === rowKey;
                                    // Check if this is a merged item by looking for DUPLICATE_MERGE movements
                                    const mergedMovements = state.movements.filter(m => m.ref === 'DUPLICATE_MERGE');
                                    const mergedSkus = [...new Set(mergedMovements.map(m => m.sku))];
                                    const isMerged = mergedSkus.includes(r.sku);
                                    // Debug logging for merged items
                                    if (isMerged) {
                                        console.log('Rendering merged item in table:', r);
                                    }
                                    return (
                                        <tr key={i} className={`border-t ${isMerged ? 'bg-yellow-50 border-yellow-200' : ''}`}>
                                            <td className="py-2 pr-3 w-32 font-medium">{r.sku}</td>
                                            <td className="py-2 pr-3 w-24">
                                                <EditableCell
                                                    sku={r.sku}
                                                    location={r.location}
                                                    field="style"
                                                    value={r.style}
                                                    isEditing={isEditing}
                                                    onSave={saveEditing}
                                                />
                                            </td>
                                            <td className="py-2 pr-3 w-24">
                                                <EditableCell
                                                    sku={r.sku}
                                                    location={r.location}
                                                    field="color"
                                                    value={r.color}
                                                    isEditing={isEditing}
                                                    onSave={saveEditing}
                                                />
                                            </td>
                                            <td className="py-2 pr-3 w-16">
                                                <EditableCell
                                                    sku={r.sku}
                                                    location={r.location}
                                                    field="size"
                                                    value={r.size}
                                                    isEditing={isEditing}
                                                    onSave={saveEditing}
                                                />
                                            </td>
                                            <td className="py-2 pr-3 w-32">
                                                <EditableCell
                                                    sku={r.sku}
                                                    location={r.location}
                                                    field="fabric"
                                                    value={r.fabric}
                                                    isEditing={isEditing}
                                                    onSave={saveEditing}
                                                />
                                            </td>
                                            <td className="py-2 pr-3 w-20">
                                                <EditableCell
                                                    sku={r.sku}
                                                    location={r.location}
                                                    field="box"
                                                    value={r.box}
                                                    isEditing={isEditing}
                                                    onSave={saveEditing}
                                                />
                                            </td>
                                            <td className="py-2 pr-3 w-20">
                                                <EditableCell
                                                    sku={r.sku}
                                                    location={r.location}
                                                    field="pallet"
                                                    value={r.pallet}
                                                    isEditing={isEditing}
                                                    onSave={saveEditing}
                                                />
                                            </td>
                                            <td className="py-2 pr-3 w-24">
                                                <EditableCell
                                                    sku={r.sku}
                                                    location={r.location}
                                                    field="label"
                                                    value={r.label}
                                                    isEditing={isEditing}
                                                    onSave={saveEditing}
                                                />
                                            </td>
                                            <td className="py-2 pr-3 w-32">
                                                <EditableCell
                                                    sku={r.sku}
                                                    location={r.location}
                                                    field="location"
                                                    value={r.location}
                                                    isEditing={isEditing}
                                                    onSave={saveEditing}
                                                />
                                            </td>
                                            <td className="py-2 pr-3 w-16">
                                                <EditableCell
                                                    sku={r.sku}
                                                    location={r.location}
                                                    field="qty"
                                                    value={r.qty}
                                                    isEditing={isEditing}
                                                    onSave={saveEditing}
                                                />
                                            </td>
                                            <td className="py-2 pr-3 w-20">
                                                {isEditing ? (
                                                    <div className="flex gap-1">
                                                        <button
                                                            onClick={() => saveEditing(r.sku, r.location, {})}
                                                            className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                                                        >
                                                            Save
                                                        </button>
                                                        <button
                                                            onClick={cancelEditing}
                                                            className="px-2 py-1 text-xs bg-gray-500 text-white rounded hover:bg-gray-600"
                                                        >
                                                            Cancel
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <button
                                                        onClick={() => startEditing(r.sku, r.location)}
                                                        className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                                                    >
                                                        Edit
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            </Section>
        );
    };

    /** ------------------------- Self-test runner -------------------------- */
    function runSelfTests() {
        const results = [];
        const ok = (name, cond, details = "") => results.push({ name, pass: !!cond, details: cond ? "" : details });

        // Test 1: CSV escaping
        const csv = toCSV(
            [
                { a: 'hello', b: 'x,y', c: 'He said "hi"\nnew line' },
            ],
            ["a", "b", "c"]
        );
        ok("toCSV escapes comma/quote/newline", csv.includes('"x,y"') && csv.includes('"He said ""hi""\nnew line"'));

        // Test 2: channelLabel mapping
        ok("channelLabel SALE->OUT - OTHER (AUTO)", channelLabel("SALE", "AUTO") === "OUT - OTHER");
        ok("channelLabel RECEIPT->IN (AUTO)", channelLabel("RECEIPT", "AUTO") === "IN");
        ok("channelLabel honors explicit channel", channelLabel("SALE", "OUT - FBA") === "OUT - FBA");

        // Test 3: buildDetailInventory totals & columns
        const sampleState = {
            products: [{ sku: "SKU1", style: "S", color: "Blue", size: "M", fabric: "Cotton", box: "B1", pallet: "P1", label: "L1" }],
            locations: [{ id: "loc1", name: "Main" }],
            movements: [
                { id: "m1", type: "RECEIPT", sku: "SKU1", location: "Main", qty: 10, ref: "PO-1", note: "", channel: "IN", ts: new Date().toISOString() },
                { id: "m2", type: "SALE", sku: "SKU1", location: "Main", qty: -3, ref: "AMZ-1", note: "", channel: "OUT - FBM", ts: new Date().toISOString() },
            ],
        };
        const det = buildDetailInventory(sampleState);
        const h = det.headers;
        ok("DETAIL front headers order", h.slice(0, 12).join(",") === "fabric,box,pallet,label,style,color,size,sku,location,TOTAL_IN,TOTAL_OUT,BALANCE");
        const row = det.rows[0] || {};
        ok("TOTAL_IN = 10", row.TOTAL_IN === 10);
        ok("TOTAL_OUT = -3", row.TOTAL_OUT === -3);
        ok("BALANCE = 7", row.BALANCE === 7);
        ok("Has PO-1__IN col", Object.keys(row).some((k) => k === "PO-1__IN"));
        ok("Has AMZ-1__OUT - FBM col", Object.keys(row).some((k) => k === "AMZ-1__OUT - FBM"));

        setTestResults(results);
        setTestsRan(true);
    }

    // Clear all data for testing
    const clearAllData = () => {
        console.log('Clearing all data...');
        localStorage.removeItem(STORAGE_KEY);
        setState({ products: [], locations: [], movements: [] });
        alert('All data cleared!');
    };

    // Refresh display and check current state
    const refreshDisplay = () => {
        console.log('=== REFRESHING DISPLAY ===');
        console.log('Current state:', state);
        console.log('Products:', state.products);
        console.log('Movements:', state.movements);
        console.log('Stock rows:', stockRows);
        console.log('Filtered stock:', filteredStock);

        // Force a re-render
        setState(prev => ({ ...prev }));
        alert('Display refreshed! Check console for current state.');
    };

    // Check merged items specifically
    const checkMergedItems = () => {
        console.log('=== CHECKING MERGED ITEMS ===');
        const mergedProducts = state.products.filter(p => p.sku.startsWith('MERGED_'));
        const mergedMovements = state.movements.filter(m => m.sku.startsWith('MERGED_'));

        console.log('Merged products:', mergedProducts);
        console.log('Merged movements:', mergedMovements);

        // Check if merged items appear in stock rows
        const mergedInStock = stockRows.filter(r => r.sku.startsWith('MERGED_'));
        console.log('Merged items in stock rows:', mergedInStock);

        // Also check all stock rows to see what's being displayed
        console.log('All stock rows:', stockRows);

        alert(`Found ${mergedProducts.length} merged products, ${mergedMovements.length} merged movements, and ${mergedInStock.length} merged items in stock display. Check console for details.`);
    };

    // Comprehensive test for duplicate merging
    const comprehensiveMergeTest = () => {
        console.log('=== COMPREHENSIVE MERGE TEST ===');

        // Step 1: Clear existing data and create fresh test duplicates
        console.log('Step 1: Creating fresh test data...');
        setState(prev => {
            const testProducts = [
                {
                    sku: "TEST_MERGE_1",
                    style: "ABC123",
                    color: "Red",
                    size: "M",
                    fabric: "Cotton",
                    box: "Box1",
                    pallet: "Pallet1",
                    label: "Label1",
                    location: "Warehouse1"
                },
                {
                    sku: "TEST_MERGE_2",
                    style: "ABC123",
                    color: "Red",
                    size: "M",
                    fabric: "Cotton",
                    box: "Box2",
                    pallet: "Pallet2",
                    label: "Label2",
                    location: "Warehouse2"
                }
            ];

            const testMovements = [
                {
                    id: uid("mv"),
                    type: "RECEIPT",
                    sku: "TEST_MERGE_1",
                    location: "Warehouse1",
                    qty: 10,
                    ref: "TEST",
                    note: "Test duplicate 1",
                    channel: "IN",
                    ts: new Date().toISOString()
                },
                {
                    id: uid("mv"),
                    type: "RECEIPT",
                    sku: "TEST_MERGE_2",
                    location: "Warehouse2",
                    qty: 15,
                    ref: "TEST",
                    note: "Test duplicate 2",
                    channel: "IN",
                    ts: new Date().toISOString()
                }
            ];

            console.log('Created test data:', { products: testProducts, movements: testMovements });
            return { ...prev, products: testProducts, movements: testMovements };
        });

        // Step 2: Wait a moment for state to update, then run merge
        setTimeout(() => {
            console.log('Step 2: Running merge detection...');

            // Manually trigger the merge process
            const currentState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"products":[],"movements":[]}');
            console.log('Current state from localStorage:', currentState);

            // Find duplicates
            const groups = {};
            currentState.products.forEach(product => {
                const key = `${product.style}${product.color}${product.size}`;
                if (!groups[key]) groups[key] = [];
                groups[key].push(product);
            });

            const duplicates = [];
            Object.entries(groups).forEach(([key, items]) => {
                if (items.length > 1) {
                    const uniqueSkus = new Set(items.map(item => item.sku));
                    const uniqueLocations = new Set(items.map(item => item.location));
                    if (uniqueSkus.size > 1 || uniqueLocations.size > 1) {
                        duplicates.push({ key, items, uniqueSkus: Array.from(uniqueSkus), uniqueLocations: Array.from(uniqueLocations) });
                    }
                }
            });

            console.log('Found duplicates:', duplicates);

            if (duplicates.length === 0) {
                alert('No duplicates found in test data!');
                return;
            }

            // Step 3: Perform merge manually
            console.log('Step 3: Performing merge...');
            const firstDuplicate = duplicates[0];
            const skusToRemove = firstDuplicate.items.map(item => item.sku);
            const selectedLocation = firstDuplicate.uniqueLocations[0];

            console.log('Merging SKUs:', skusToRemove);
            console.log('Selected location:', selectedLocation);

            // Calculate total quantity
            const movementsForSkus = currentState.movements.filter(m => skusToRemove.includes(m.sku));
            const totalQty = movementsForSkus.reduce((sum, m) => {
                if (m.type === 'RECEIPT' || m.type === 'TRANSFER_IN') return sum + (m.qty || 0);
                if (m.type === 'SALE' || m.type === 'TRANSFER_OUT') return sum - (m.qty || 0);
                return sum + (m.qty || 0);
            }, 0);

            console.log('Movements for SKUs:', movementsForSkus);
            console.log('Total quantity:', totalQty);

            // Perform the merge
            const updatedProducts = currentState.products.filter(p => !skusToRemove.includes(p.sku));
            const updatedMovements = currentState.movements.filter(m => !skusToRemove.includes(m.sku));

            const firstItem = firstDuplicate.items[0];
            const newSku = `MERGED_${uid("sku")}`;

            const newProduct = {
                sku: newSku,
                style: firstItem.style,
                color: firstItem.color,
                size: firstItem.size,
                fabric: firstItem.fabric || "N/A",
                box: firstItem.box || "N/A",
                pallet: firstItem.pallet || "N/A",
                label: firstItem.label || "N/A",
                location: selectedLocation
            };

            const newMovement = {
                id: uid("mv"),
                type: "RECEIPT",
                sku: newSku,
                location: selectedLocation,
                qty: Math.max(0, totalQty),
                ref: "COMPREHENSIVE_TEST",
                note: `Comprehensive test merge of ${skusToRemove.join(', ')}`,
                channel: "IN",
                ts: new Date().toISOString()
            };

            updatedProducts.push(newProduct);
            updatedMovements.push(newMovement);

            const newState = {
                ...currentState,
                products: updatedProducts,
                movements: updatedMovements
            };

            console.log('New state after merge:', newState);

            // Update both localStorage and React state
            localStorage.setItem(STORAGE_KEY, JSON.stringify(newState));
            setState(newState);

            // Force immediate state synchronization
            setTimeout(() => {
                console.log('Forcing immediate state sync...');
                const storedState = JSON.parse(localStorage.getItem(STORAGE_KEY));
                if (storedState) {
                    setState(storedState);
                }
            }, 50);

            // Force a refresh of the display
            setTimeout(() => {
                console.log('Forcing display refresh after merge...');
                setState(prev => ({ ...prev })); // Trigger re-render
            }, 100);

            console.log('Step 4: Merge completed!');
            console.log('Original products count:', currentState.products.length);
            console.log('Final products count:', updatedProducts.length);
            console.log('Original movements count:', currentState.movements.length);
            console.log('Final movements count:', updatedMovements.length);
            console.log('New merged product:', newProduct);
            console.log('New merged movement:', newMovement);

            alert(`Comprehensive merge test completed!\nOriginal: ${currentState.products.length} products, ${currentState.movements.length} movements\nFinal: ${updatedProducts.length} products, ${updatedMovements.length} movements\nCheck console for details.`);

        }, 1000); // Wait 1 second for state to update
    };

    // Detailed diagnostic for merge quantity issue
    const diagnoseMergeQuantity = () => {
        console.log('=== DIAGNOSING MERGE QUANTITY ISSUE ===');

        // Step 1: Create simple test data with known quantities
        console.log('Step 1: Creating test data...');
        setState(prev => {
            const testProducts = [
                {
                    sku: "DIAG_1",
                    style: "TEST",
                    color: "RED",
                    size: "M",
                    fabric: "COTTON",
                    box: "BOX1",
                    pallet: "PALLET1",
                    label: "LABEL1",
                    location: "WAREHOUSE1"
                },
                {
                    sku: "DIAG_2",
                    style: "TEST",
                    color: "RED",
                    size: "M",
                    fabric: "COTTON",
                    box: "BOX2",
                    pallet: "PALLET2",
                    label: "LABEL2",
                    location: "WAREHOUSE2"
                }
            ];

            const testMovements = [
                {
                    id: uid("mv"),
                    type: "RECEIPT",
                    sku: "DIAG_1",
                    location: "WAREHOUSE1",
                    qty: 50,
                    ref: "DIAG",
                    note: "Diagnostic test 1",
                    channel: "IN",
                    ts: new Date().toISOString()
                },
                {
                    id: uid("mv"),
                    type: "RECEIPT",
                    sku: "DIAG_2",
                    location: "WAREHOUSE2",
                    qty: 75,
                    ref: "DIAG",
                    note: "Diagnostic test 2",
                    channel: "IN",
                    ts: new Date().toISOString()
                }
            ];

            console.log('Created test data:', { products: testProducts, movements: testMovements });
            return { ...prev, products: testProducts, movements: testMovements };
        });

        // Step 2: Wait and then perform merge manually
        setTimeout(() => {
            console.log('Step 2: Performing merge...');

            const currentState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"products":[],"movements":[]}');
            console.log('Current state before merge:', currentState);

            // Find duplicates
            const groups = {};
            currentState.products.forEach(product => {
                const key = `${product.style}${product.color}${product.size}`;
                if (!groups[key]) groups[key] = [];
                groups[key].push(product);
            });

            const duplicates = [];
            Object.entries(groups).forEach(([key, items]) => {
                if (items.length > 1) {
                    const uniqueSkus = new Set(items.map(item => item.sku));
                    const uniqueLocations = new Set(items.map(item => item.location));
                    if (uniqueSkus.size > 1 || uniqueLocations.size > 1) {
                        duplicates.push({ key, items, uniqueSkus: Array.from(uniqueSkus), uniqueLocations: Array.from(uniqueLocations) });
                    }
                }
            });

            console.log('Found duplicates:', duplicates);

            if (duplicates.length === 0) {
                alert('No duplicates found for diagnosis!');
                return;
            }

            // Perform merge
            const firstDuplicate = duplicates[0];
            const skusToRemove = firstDuplicate.items.map(item => item.sku);
            const selectedLocation = firstDuplicate.uniqueLocations[0];

            console.log('Merging SKUs:', skusToRemove);
            console.log('Selected location:', selectedLocation);

            // Calculate total quantity
            const movementsForSkus = currentState.movements.filter(m => skusToRemove.includes(m.sku));
            const totalQty = movementsForSkus.reduce((sum, m) => {
                if (m.type === 'RECEIPT' || m.type === 'TRANSFER_IN') return sum + (m.qty || 0);
                if (m.type === 'SALE' || m.type === 'TRANSFER_OUT') return sum - (m.qty || 0);
                return sum + (m.qty || 0);
            }, 0);

            console.log('Movements for SKUs:', movementsForSkus);
            console.log('Total quantity calculated:', totalQty);

            // Perform the merge
            const updatedProducts = currentState.products.filter(p => !skusToRemove.includes(p.sku));
            const updatedMovements = currentState.movements.filter(m => !skusToRemove.includes(m.sku));

            const firstItem = firstDuplicate.items[0];
            const newSku = `MERGED_DIAG_${uid("sku")}`;

            const newProduct = {
                sku: newSku,
                style: firstItem.style,
                color: firstItem.color,
                size: firstItem.size,
                fabric: firstItem.fabric || "N/A",
                box: firstItem.box || "N/A",
                pallet: firstItem.pallet || "N/A",
                label: firstItem.label || "N/A",
                location: selectedLocation
            };

            const newMovement = {
                id: uid("mv"),
                type: "RECEIPT",
                sku: newSku,
                location: selectedLocation,
                qty: Math.max(0, totalQty),
                ref: "DIAG_MERGE",
                note: `Diagnostic merge of ${skusToRemove.join(', ')}`,
                channel: "IN",
                ts: new Date().toISOString()
            };

            updatedProducts.push(newProduct);
            updatedMovements.push(newMovement);

            const newState = {
                ...currentState,
                products: updatedProducts,
                movements: updatedMovements
            };

            console.log('New state after merge:', newState);
            console.log('New product:', newProduct);
            console.log('New movement:', newMovement);

            // Update state
            localStorage.setItem(STORAGE_KEY, JSON.stringify(newState));
            setState(newState);

            // Force immediate state synchronization
            setTimeout(() => {
                console.log('Forcing immediate state sync in comprehensive test...');
                const storedState = JSON.parse(localStorage.getItem(STORAGE_KEY));
                if (storedState) {
                    setState(storedState);
                }
            }, 50);

            // Step 3: Wait and check if the merged item appears in stock calculation
            setTimeout(() => {
                console.log('Step 3: Checking stock calculation...');

                // Manually calculate what stockRows should show
                const byKey = new Map();
                const pBySKU = new Map(newState.products.map((p) => [p.sku, p]));

                console.log('Products in calculation:', newState.products);
                console.log('Movements in calculation:', newState.movements);

                for (const m of newState.movements) {
                    if (!pBySKU.has(m.sku)) {
                        console.log('Movement SKU not found in products:', m.sku);
                        continue;
                    }

                    // Handle undefined location
                    const location = m.location || "Unknown Location";
                    const key = `${m.sku}@@${location}`;
                    const prev = byKey.get(key) || 0;
                    const delta = Number(m.qty || 0);
                    byKey.set(key, prev + delta);
                    console.log('Movement processed:', { sku: m.sku, location: location, qty: m.qty, delta, newTotal: prev + delta });
                }

                const calculatedRows = [];
                for (const [k, qty] of byKey) {
                    const [sku, location] = k.split("@@");
                    const p = pBySKU.get(sku);
                    if (!p) {
                        console.log('Product not found for SKU:', sku);
                        continue;
                    }
                    calculatedRows.push({
                        sku,
                        style: p.style,
                        color: p.color,
                        size: p.size,
                        location,
                        qty: qty,
                        fabric: p.fabric || "",
                        box: p.box || "",
                        pallet: p.pallet || "",
                        label: p.label || "",
                    });
                }

                console.log('Manually calculated stock rows:', calculatedRows);
                const mergedInCalculated = calculatedRows.filter(r => r.sku.startsWith('MERGED_'));
                console.log('Merged items in calculated rows:', mergedInCalculated);

                alert(`Diagnostic complete!\nExpected total quantity: ${totalQty}\nMerged items in calculation: ${mergedInCalculated.length}\nCheck console for detailed analysis.`);

            }, 500);

        }, 1000);
    };

    // Force refresh and check display issues
    const forceRefreshAndCheck = () => {
        console.log('=== FORCE REFRESH AND CHECK ===');

        // Clear any search filters
        setQuery("");

        // Reset sorting
        setSortConfig({ key: null, direction: null });

        // Force multiple re-renders
        setState(prev => ({ ...prev }));

        setTimeout(() => {
            setState(prev => ({ ...prev }));
        }, 100);

        setTimeout(() => {
            setState(prev => ({ ...prev }));
        }, 200);

        // Check current state
        console.log('Current state after refresh:', state);
        console.log('Current stock rows:', stockRows);
        console.log('Current filtered stock:', filteredStock);
        console.log('Search query:', query);
        console.log('Sort config:', sortConfig);

        // Check if merged items are visible
        const mergedInStock = stockRows.filter(r => r.sku.startsWith('MERGED_'));
        const mergedInFiltered = filteredStock.filter(r => r.sku.startsWith('MERGED_'));

        console.log('Merged items in stock rows:', mergedInStock);
        console.log('Merged items in filtered stock:', mergedInFiltered);

        alert(`Refresh completed!\nMerged items in stock: ${mergedInStock.length}\nMerged items in filtered: ${mergedInFiltered.length}\nSearch query: "${query}"\nCheck console for details.`);
    };

    // Debug quantity display specifically
    const debugQuantityDisplay = () => {
        console.log('=== DEBUGGING QUANTITY DISPLAY ===');

        // Check all stock rows and their quantities
        console.log('All stock rows with quantities:');
        stockRows.forEach((row, index) => {
            console.log(`Row ${index}: SKU=${row.sku}, Qty=${row.qty}, Type=${typeof row.qty}`);
        });

        // Check filtered stock
        console.log('All filtered stock with quantities:');
        filteredStock.forEach((row, index) => {
            console.log(`Filtered Row ${index}: SKU=${row.sku}, Qty=${row.qty}, Type=${typeof row.qty}`);
        });

        // Check merged items specifically
        const mergedItems = stockRows.filter(r => r.sku.startsWith('MERGED_'));
        console.log('Merged items with quantities:', mergedItems);

        // Check if quantities are numbers
        const quantityIssues = stockRows.filter(r => typeof r.qty !== 'number' || isNaN(r.qty));
        if (quantityIssues.length > 0) {
            console.log('Items with quantity issues:', quantityIssues);
        }

        // Manually recalculate quantities
        console.log('=== MANUAL QUANTITY RECALCULATION ===');
        const byKey = new Map();
        const pBySKU = new Map(state.products.map((p) => [p.sku, p]));

        for (const m of state.movements) {
            if (!pBySKU.has(m.sku)) continue;
            const key = `${m.sku}@@${m.location}`;
            const prev = byKey.get(key) || 0;
            const delta = Number(m.qty || 0);
            byKey.set(key, prev + delta);
            console.log(`Movement: SKU=${m.sku}, Location=${m.location}, Qty=${m.qty}, Delta=${delta}, Running Total=${prev + delta}`);
        }

        console.log('Manual calculation results:');
        for (const [k, qty] of byKey) {
            const [sku, location] = k.split("@@");
            console.log(`Manual: SKU=${sku}, Location=${location}, Qty=${qty}`);
        }

        alert(`Quantity debug complete!\nStock rows: ${stockRows.length}\nFiltered rows: ${filteredStock.length}\nMerged items: ${mergedItems.length}\nQuantity issues: ${quantityIssues.length}\nCheck console for details.`);
    };

    // Check current state and force display update
    const checkCurrentStateAndDisplay = () => {
        console.log('=== CHECKING CURRENT STATE AND DISPLAY ===');

        // Get current state from localStorage
        const currentState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"products":[],"movements":[]}');
        console.log('Current state from localStorage:', currentState);

        // Check React state
        console.log('Current React state:', state);

        // Check stock calculation
        console.log('Current stock rows:', stockRows);
        console.log('Current filtered stock:', filteredStock);

        // Check for merged items
        const mergedProducts = currentState.products.filter(p => p.sku.startsWith('MERGED_'));
        const mergedMovements = currentState.movements.filter(m => m.sku.startsWith('MERGED_'));
        const mergedInStock = stockRows.filter(r => r.sku.startsWith('MERGED_'));
        const mergedInFiltered = filteredStock.filter(r => r.sku.startsWith('MERGED_'));

        console.log('Merged products in state:', mergedProducts);
        console.log('Merged movements in state:', mergedMovements);
        console.log('Merged items in stock rows:', mergedInStock);
        console.log('Merged items in filtered stock:', mergedInFiltered);

        // Force a complete refresh
        setQuery("");
        setSortConfig({ key: null, direction: null });
        setState(prev => ({ ...prev }));

        alert(`State check complete!\nProducts: ${currentState.products.length}\nMovements: ${currentState.movements.length}\nStock rows: ${stockRows.length}\nFiltered rows: ${filteredStock.length}\nMerged products: ${mergedProducts.length}\nMerged in stock: ${mergedInStock.length}\nMerged in filtered: ${mergedInFiltered.length}\nCheck console for details.`);
    };

    // Test complete merge and display workflow
    const testCompleteMergeWorkflow = () => {
        console.log('=== TESTING COMPLETE MERGE WORKFLOW ===');

        // Step 1: Create duplicates
        console.log('Step 1: Creating duplicates...');
        setState(prev => {
            const testProducts = [
                {
                    sku: "WORKFLOW_1",
                    style: "TEST_STYLE",
                    color: "TEST_COLOR",
                    size: "TEST_SIZE",
                    fabric: "TEST_FABRIC",
                    box: "TEST_BOX1",
                    pallet: "TEST_PALLET1",
                    label: "TEST_LABEL1",
                    location: "TEST_LOCATION1"
                },
                {
                    sku: "WORKFLOW_2",
                    style: "TEST_STYLE",
                    color: "TEST_COLOR",
                    size: "TEST_SIZE",
                    fabric: "TEST_FABRIC",
                    box: "TEST_BOX2",
                    pallet: "TEST_PALLET2",
                    label: "TEST_LABEL2",
                    location: "TEST_LOCATION2"
                }
            ];

            const testMovements = [
                {
                    id: uid("mv"),
                    type: "RECEIPT",
                    sku: "WORKFLOW_1",
                    location: "TEST_LOCATION1",
                    qty: 100,
                    ref: "WORKFLOW_TEST",
                    note: "Workflow test 1",
                    channel: "IN",
                    ts: new Date().toISOString()
                },
                {
                    id: uid("mv"),
                    type: "RECEIPT",
                    sku: "WORKFLOW_2",
                    location: "TEST_LOCATION2",
                    qty: 200,
                    ref: "WORKFLOW_TEST",
                    note: "Workflow test 2",
                    channel: "IN",
                    ts: new Date().toISOString()
                }
            ];

            console.log('Created workflow test data:', { products: testProducts, movements: testMovements });
            return { ...prev, products: testProducts, movements: testMovements };
        });

        // Step 2: Wait and check initial state
        setTimeout(() => {
            console.log('Step 2: Checking initial state...');
            console.log('Initial stock rows:', stockRows);
            console.log('Initial filtered stock:', filteredStock);

            // Step 3: Perform merge
            console.log('Step 3: Performing merge...');
            const currentState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"products":[],"movements":[]}');

            // Find duplicates
            const groups = {};
            currentState.products.forEach(product => {
                const key = `${product.style}${product.color}${product.size}`;
                if (!groups[key]) groups[key] = [];
                groups[key].push(product);
            });

            const duplicates = [];
            Object.entries(groups).forEach(([key, items]) => {
                if (items.length > 1) {
                    const uniqueSkus = new Set(items.map(item => item.sku));
                    const uniqueLocations = new Set(items.map(item => item.location));
                    if (uniqueSkus.size > 1 || uniqueLocations.size > 1) {
                        duplicates.push({ key, items, uniqueSkus: Array.from(uniqueSkus), uniqueLocations: Array.from(uniqueLocations) });
                    }
                }
            });

            console.log('Found duplicates:', duplicates);

            if (duplicates.length === 0) {
                alert('No duplicates found for workflow test!');
                return;
            }

            // Perform merge
            const firstDuplicate = duplicates[0];
            const skusToRemove = firstDuplicate.items.map(item => item.sku);
            const selectedLocation = firstDuplicate.uniqueLocations[0];

            console.log('Merging SKUs:', skusToRemove);
            console.log('Selected location:', selectedLocation);

            // Calculate total quantity
            const movementsForSkus = currentState.movements.filter(m => skusToRemove.includes(m.sku));
            const totalQty = movementsForSkus.reduce((sum, m) => {
                if (m.type === 'RECEIPT' || m.type === 'TRANSFER_IN') return sum + (m.qty || 0);
                if (m.type === 'SALE' || m.type === 'TRANSFER_OUT') return sum - (m.qty || 0);
                return sum + (m.qty || 0);
            }, 0);

            console.log('Total quantity to merge:', totalQty);

            // Perform the merge
            const updatedProducts = currentState.products.filter(p => !skusToRemove.includes(p.sku));
            const updatedMovements = currentState.movements.filter(m => !skusToRemove.includes(m.sku));

            const firstItem = firstDuplicate.items[0];
            const newSku = `MERGED_WORKFLOW_${uid("sku")}`;

            const newProduct = {
                sku: newSku,
                style: firstItem.style,
                color: firstItem.color,
                size: firstItem.size,
                fabric: firstItem.fabric || "N/A",
                box: firstItem.box || "N/A",
                pallet: firstItem.pallet || "N/A",
                label: firstItem.label || "N/A",
                location: selectedLocation
            };

            const newMovement = {
                id: uid("mv"),
                type: "RECEIPT",
                sku: newSku,
                location: selectedLocation,
                qty: Math.max(0, totalQty),
                ref: "WORKFLOW_MERGE",
                note: `Workflow merge of ${skusToRemove.join(', ')}`,
                channel: "IN",
                ts: new Date().toISOString()
            };

            updatedProducts.push(newProduct);
            updatedMovements.push(newMovement);

            const newState = {
                ...currentState,
                products: updatedProducts,
                movements: updatedMovements
            };

            console.log('New state after merge:', newState);
            console.log('New merged product:', newProduct);
            console.log('New merged movement:', newMovement);

            // Update state
            localStorage.setItem(STORAGE_KEY, JSON.stringify(newState));
            setState(newState);

            // Step 4: Wait and check final state
            setTimeout(() => {
                console.log('Step 4: Checking final state...');
                console.log('Final stock rows:', stockRows);
                console.log('Final filtered stock:', filteredStock);

                // Check if merged item appears in stock calculation
                const mergedInStock = stockRows.filter(r => r.sku.startsWith('MERGED_WORKFLOW_'));
                const mergedInFiltered = filteredStock.filter(r => r.sku.startsWith('MERGED_WORKFLOW_'));

                console.log('Merged items in stock rows:', mergedInStock);
                console.log('Merged items in filtered stock:', mergedInFiltered);

                // Check all items in display
                console.log('All items in stock rows:', stockRows.map(r => ({ sku: r.sku, qty: r.qty })));
                console.log('All items in filtered stock:', filteredStock.map(r => ({ sku: r.sku, qty: r.qty })));

                alert(`Workflow test complete!\nExpected quantity: ${totalQty}\nMerged items in stock: ${mergedInStock.length}\nMerged items in filtered: ${mergedInFiltered.length}\nTotal stock rows: ${stockRows.length}\nTotal filtered rows: ${filteredStock.length}\nCheck console for details.`);

            }, 1000);

        }, 1000);
    };

    // Clear everything and start fresh
    const clearAndStartFresh = () => {
        console.log('=== CLEARING EVERYTHING AND STARTING FRESH ===');

        // Clear localStorage
        localStorage.removeItem(STORAGE_KEY);

        // Reset React state
        setState({ products: [], locations: [], movements: [] });

        // Clear any filters or sorting
        setQuery("");
        setSortConfig({ key: null, direction: null });

        console.log('Everything cleared. Ready for fresh start.');
        alert('Everything cleared! You can now create new data and test the merge functionality.');
    };

    // Simple check and restore function
    const checkAndRestore = () => {
        console.log('=== SIMPLE CHECK AND RESTORE ===');

        // Check what's currently in the system
        const currentState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"products":[],"movements":[]}');
        console.log('Current state:', currentState);

        // Check if there are any merged items
        const mergedProducts = currentState.products.filter(p => p.sku.startsWith('MERGED_'));
        const mergedMovements = currentState.movements.filter(m => m.sku.startsWith('MERGED_'));

        console.log('Merged products found:', mergedProducts);
        console.log('Merged movements found:', mergedMovements);

        if (mergedProducts.length === 0) {
            console.log('No merged products found. Creating test data...');

            // Create simple test data that should work
            const testProducts = [
                {
                    sku: "MERGED_TEST_1",
                    style: "TEST",
                    color: "BLUE",
                    size: "M",
                    fabric: "COTTON",
                    box: "BOX1",
                    pallet: "PALLET1",
                    label: "LABEL1",
                    location: "WAREHOUSE1"
                }
            ];

            const testMovements = [
                {
                    id: uid("mv"),
                    type: "RECEIPT",
                    sku: "MERGED_TEST_1",
                    location: "WAREHOUSE1",
                    qty: 150,
                    ref: "TEST_RESTORE",
                    note: "Test restore",
                    channel: "IN",
                    ts: new Date().toISOString()
                }
            ];

            const newState = {
                ...currentState,
                products: testProducts,
                movements: testMovements
            };

            localStorage.setItem(STORAGE_KEY, JSON.stringify(newState));
            setState(newState);

            console.log('Created test merged item with quantity 150');
            alert('Created test merged item with quantity 150. Check if it appears in the table now.');

        } else {
            console.log('Found existing merged items. Checking if they appear in display...');

            // Force refresh
            setQuery("");
            setSortConfig({ key: null, direction: null });
            setState(prev => ({ ...prev }));

            alert(`Found ${mergedProducts.length} merged products and ${mergedMovements.length} merged movements. Forced refresh. Check if they appear now.`);
        }
    };

    // Check state immediately after merge
    const checkStateAfterMerge = () => {
        console.log('=== CHECKING STATE AFTER MERGE ===');

        // Get current state
        const currentState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"products":[],"movements":[]}');
        console.log('Current state from localStorage:', currentState);

        // Check for merged items (look for movements with DUPLICATE_MERGE ref)
        const mergedMovements = currentState.movements.filter(m => m.ref === 'DUPLICATE_MERGE');
        const mergedSkus = [...new Set(mergedMovements.map(m => m.sku))];
        const mergedProducts = currentState.products.filter(p => mergedSkus.includes(p.sku));

        console.log('Merged movements found:', mergedMovements);
        console.log('Merged products found:', mergedProducts);

        // Force React state to match localStorage
        setState(currentState);

        // Force a complete refresh
        setQuery("");
        setSortConfig({ key: null, direction: null });

        // Wait and check stock calculation
        setTimeout(() => {
            console.log('Stock rows after merge:', stockRows);
            console.log('Filtered stock after merge:', filteredStock);

            const mergedInStock = stockRows.filter(r => mergedSkus.includes(r.sku));
            console.log('Merged items in stock rows:', mergedInStock);

            alert(`State check after merge:\nMerged products: ${mergedProducts.length}\nMerged movements: ${mergedMovements.length}\nMerged in stock: ${mergedInStock.length}\nCheck console for details.`);
        }, 500);
    };

    // Fix any merged movements with undefined locations
    const fixMergedMovements = () => {
        console.log('=== FIXING MERGED MOVEMENTS ===');

        setState(prev => {
            let updatedMovements = [...prev.movements];
            let hasChanges = false;

            // Find merged movements with undefined locations
            const mergedMovements = updatedMovements.filter(m => m.sku.startsWith('MERGED_'));
            console.log('Found merged movements:', mergedMovements);

            mergedMovements.forEach(movement => {
                if (!movement.location) {
                    console.log('Fixing movement with undefined location:', movement);
                    // Try to find the corresponding product to get the location
                    const product = prev.products.find(p => p.sku === movement.sku);
                    if (product && product.location) {
                        movement.location = product.location;
                        hasChanges = true;
                        console.log('Fixed movement location to:', product.location);
                    } else {
                        // Fallback to a default location
                        movement.location = "Unknown Location";
                        hasChanges = true;
                        console.log('Set movement location to default: Unknown Location');
                    }
                }
            });

            if (hasChanges) {
                console.log('Updating movements with location fixes');
                localStorage.setItem(STORAGE_KEY, JSON.stringify({
                    ...prev,
                    movements: updatedMovements
                }));
                return {
                    ...prev,
                    movements: updatedMovements
                };
            }

            return prev;
        });
    };

    // Comprehensive debug to find where merged items are lost
    const debugMergedItemsPipeline = () => {
        console.log('=== DEBUGGING MERGED ITEMS PIPELINE ===');

        // 1. Check localStorage
        const storedState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"products":[],"movements":[]}');
        console.log('1. localStorage state:', storedState);

        const storedMergedProducts = storedState.products.filter(p => p.sku.startsWith('MERGED_'));
        const storedMergedMovements = storedState.movements.filter(m => m.sku.startsWith('MERGED_'));
        console.log('1. Stored merged products:', storedMergedProducts);
        console.log('1. Stored merged movements:', storedMergedMovements);

        // 2. Check React state
        console.log('2. React state:', state);
        const reactMergedProducts = state.products.filter(p => p.sku.startsWith('MERGED_'));
        const reactMergedMovements = state.movements.filter(m => m.sku.startsWith('MERGED_'));
        console.log('2. React merged products:', reactMergedProducts);
        console.log('2. React merged movements:', reactMergedMovements);

        // 3. Check stockRows calculation
        console.log('3. stockRows calculation:');
        const byKey = new Map();
        const pBySKU = new Map(state.products.map((p) => [p.sku, p]));

        console.log('3a. Products map:', Array.from(pBySKU.entries()));

        for (const m of state.movements) {
            if (!pBySKU.has(m.sku)) {
                console.log('3b. Movement SKU not found in products:', m.sku);
                continue;
            }

            const location = m.location || "Unknown Location";
            const key = `${m.sku}@@${location}`;
            const prev = byKey.get(key) || 0;
            const delta = Number(m.qty || 0);
            byKey.set(key, prev + delta);

            if (m.sku.startsWith('MERGED_')) {
                console.log('3c. Merged movement processed:', { sku: m.sku, location, qty: m.qty, delta, newTotal: prev + delta });
            }
        }

        console.log('3d. Final byKey map:', Array.from(byKey.entries()));

        const calculatedRows = [];
        for (const [k, qty] of byKey) {
            const [sku, location] = k.split("@@");
            const p = pBySKU.get(sku);
            if (!p) {
                console.log('3e. Product not found for SKU:', sku);
                continue;
            }
            calculatedRows.push({
                sku,
                style: p.style,
                color: p.color,
                size: p.size,
                location,
                qty: qty,
                fabric: p.fabric || "",
                box: p.box || "",
                pallet: p.pallet || "",
                label: p.label || "",
            });
        }

        const mergedInCalculated = calculatedRows.filter(r => r.sku.startsWith('MERGED_'));
        console.log('3f. Merged items in calculated rows:', mergedInCalculated);

        // 4. Check actual stockRows
        console.log('4. Actual stockRows:', stockRows);
        const mergedInStockRows = stockRows.filter(r => r.sku.startsWith('MERGED_'));
        console.log('4. Merged items in stockRows:', mergedInStockRows);

        // 5. Check filtered stock
        console.log('5. Filtered stock:', filteredStock);
        const mergedInFiltered = filteredStock.filter(r => r.sku.startsWith('MERGED_'));
        console.log('5. Merged items in filtered stock:', mergedInFiltered);

        // 6. Check search and sort
        console.log('6. Search query:', query);
        console.log('6. Sort config:', sortConfig);

        // 7. Force a complete refresh
        console.log('7. Forcing complete refresh...');
        setQuery("");
        setSortConfig({ key: null, direction: null });

        setTimeout(() => {
            console.log('8. After refresh - stockRows:', stockRows);
            console.log('8. After refresh - filteredStock:', filteredStock);
            const finalMerged = stockRows.filter(r => r.sku.startsWith('MERGED_'));
            console.log('8. After refresh - merged items:', finalMerged);

            alert(`Debug complete!\nStored merged: ${storedMergedProducts.length} products, ${storedMergedMovements.length} movements\nReact merged: ${reactMergedProducts.length} products, ${reactMergedMovements.length} movements\nCalculated merged: ${mergedInCalculated.length}\nStockRows merged: ${mergedInStockRows.length}\nFiltered merged: ${mergedInFiltered.length}\nFinal merged: ${finalMerged.length}\nCheck console for details.`);
        }, 1000);
    };

    // Manually create a test merged item
    const createTestMergedItem = () => {
        console.log('=== CREATING TEST MERGED ITEM ===');

        const testSku = `MERGED_TEST_${uid("sku")}`;
        const testProduct = {
            sku: testSku,
            style: 'TEST_STYLE',
            color: 'TEST_COLOR',
            size: 'TEST_SIZE',
            fabric: 'TEST_FABRIC',
            box: 'TEST_BOX',
            pallet: 'TEST_PALLET',
            label: 'TEST_LABEL',
            location: 'TEST_LOCATION'
        };

        const testMovement = {
            id: uid("mv"),
            type: "RECEIPT",
            sku: testSku,
            location: 'TEST_LOCATION',
            qty: 100,
            ref: "TEST_MERGE",
            note: "Test merged item",
            channel: "IN",
            ts: new Date().toISOString()
        };

        console.log('Creating test product:', testProduct);
        console.log('Creating test movement:', testMovement);

        setState(prev => {
            const newState = {
                ...prev,
                products: [...prev.products, testProduct],
                movements: [...prev.movements, testMovement]
            };

            localStorage.setItem(STORAGE_KEY, JSON.stringify(newState));
            console.log('Test merged item created and saved');

            return newState;
        });

        // Check if it appears
        setTimeout(() => {
            console.log('Checking if test merged item appears...');
            const mergedInStock = stockRows.filter(r => r.sku.startsWith('MERGED_'));
            console.log('Merged items in stock after test:', mergedInStock);

            alert(`Test merged item created!\nSKU: ${testSku}\nQuantity: 100\nMerged items in stock: ${mergedInStock.length}\nCheck console for details.`);
        }, 500);
    };

    // Force display merged items in table
    const forceDisplayMergedItems = () => {
        console.log('=== FORCING DISPLAY OF MERGED ITEMS ===');

        // First, ensure we have the latest state
        const storedState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"products":[],"movements":[]}');
        console.log('Current stored state:', storedState);

        // Force React state to match localStorage
        setState(storedState);

        // Clear any filters that might be hiding merged items
        setQuery("");
        setSortConfig({ key: null, direction: null });

        // Force multiple re-renders to ensure display updates
        setTimeout(() => {
            console.log('Forcing first re-render...');
            setState(prev => ({ ...prev }));
        }, 100);

        setTimeout(() => {
            console.log('Forcing second re-render...');
            setState(prev => ({ ...prev }));
        }, 200);

        setTimeout(() => {
            console.log('Forcing third re-render...');
            setState(prev => ({ ...prev }));
        }, 300);

        // Check final state
        setTimeout(() => {
            console.log('Final check - stockRows:', stockRows);
            console.log('Final check - filteredStock:', filteredStock);

            const mergedInStock = stockRows.filter(r => r.sku.startsWith('MERGED_'));
            const mergedInFiltered = filteredStock.filter(r => r.sku.startsWith('MERGED_'));

            console.log('Merged items in stock:', mergedInStock);
            console.log('Merged items in filtered:', mergedInFiltered);

            if (mergedInStock.length > 0) {
                console.log('✅ Merged items found in stock calculation');
                if (mergedInFiltered.length > 0) {
                    console.log('✅ Merged items found in filtered display');
                    alert(`Success! Found ${mergedInFiltered.length} merged items in the display.\n\nMerged items:\n${mergedInFiltered.map(item => `${item.sku}: ${item.qty} units at ${item.location}`).join('\n')}`);
                } else {
                    console.log('❌ Merged items in stock but not in filtered display');
                    alert(`Issue: ${mergedInStock.length} merged items in stock but not in filtered display.\nCheck search/filter settings.`);
                }
            } else {
                console.log('❌ No merged items found in stock calculation');
                alert(`Issue: No merged items found in stock calculation.\nCheck if merge was successful.`);
            }
        }, 500);
    };

    // Add visual indicator for merged items and ensure they're displayed
    const highlightMergedItems = () => {
        console.log('=== HIGHLIGHTING MERGED ITEMS ===');

        // Force a refresh to ensure merged items are included
        setQuery("");
        setSortConfig({ key: null, direction: null });

        // Check if merged items exist by looking for DUPLICATE_MERGE movements
        const mergedMovements = state.movements.filter(m => m.ref === 'DUPLICATE_MERGE');
        const mergedSkus = [...new Set(mergedMovements.map(m => m.sku))];
        const mergedItems = stockRows.filter(r => mergedSkus.includes(r.sku));

        console.log('Merged items found in stockRows:', mergedItems);

        if (mergedItems.length > 0) {
            console.log('✅ Found merged items, they should be visible in the table');
            alert(`Found ${mergedItems.length} merged items that should be visible:\n\n${mergedItems.map(item => `• ${item.sku}: ${item.qty} units at ${item.location}`).join('\n')}\n\nLook for these items in the table below.`);
        } else {
            console.log('❌ No merged items found in stockRows');
            alert('No merged items found in the stock calculation. The merge may not have been successful.');
        }
    };

    // Check and clean up any remaining duplicates after merge
    const checkAndCleanDuplicates = () => {
        console.log('=== CHECKING AND CLEANING DUPLICATES ===');

        setState(prev => {
            let updatedProducts = [...prev.products];
            let updatedMovements = [...prev.movements];
            let hasChanges = false;

            // Group products by Style + Color + Size
            const groups = {};
            updatedProducts.forEach(product => {
                const key = `${product.style}${product.color}${product.size}`;
                if (!groups[key]) groups[key] = [];
                groups[key].push(product);
            });

            // Find groups with multiple items
            Object.entries(groups).forEach(([key, items]) => {
                if (items.length > 1) {
                    console.log('Found duplicate group:', key, 'with items:', items);

                    // Keep only the first item, remove the rest
                    const itemsToRemove = items.slice(1);
                    const skusToRemove = itemsToRemove.map(item => item.sku);

                    console.log('Removing duplicate SKUs:', skusToRemove);

                    // Remove duplicate products
                    updatedProducts = updatedProducts.filter(p => !skusToRemove.includes(p.sku));

                    // Remove movements for duplicate SKUs
                    updatedMovements = updatedMovements.filter(m => !skusToRemove.includes(m.sku));

                    hasChanges = true;
                }
            });

            if (hasChanges) {
                console.log('Cleaned up duplicates. New product count:', updatedProducts.length);
                return {
                    ...prev,
                    products: updatedProducts,
                    movements: updatedMovements
                };
            }

            return prev;
        });
    };

    // Show all products with the same Style+Color+Size
    const showDuplicateGroups = () => {
        console.log('=== SHOWING ALL DUPLICATE GROUPS ===');

        const groups = {};
        state.products.forEach(product => {
            const key = `${product.style}${product.color}${product.size}`;
            if (!groups[key]) groups[key] = [];
            groups[key].push(product);
        });

        let duplicateCount = 0;
        Object.entries(groups).forEach(([key, items]) => {
            if (items.length > 1) {
                duplicateCount++;
                console.log(`Duplicate Group ${duplicateCount}:`, key);
                console.log('Items:', items);

                // Show movements for each item
                items.forEach(item => {
                    const movements = state.movements.filter(m => m.sku === item.sku);
                    console.log(`  SKU ${item.sku} (${item.location}):`, movements);
                });
                console.log('---');
            }
        });

        if (duplicateCount === 0) {
            console.log('No duplicate groups found!');
            alert('No duplicate groups found in the current data.');
        } else {
            alert(`Found ${duplicateCount} duplicate groups. Check console for details.`);
        }
    };

    return (
        <div className="min-h-screen bg-gray-100">
            <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
                <div className="max-w-full mx-auto px-4 py-3 flex items-center justify-between">
                    <div className="text-lg font-semibold">Simple ERP – Inventory</div>
                    <div className="flex gap-2">
                        <ToolbarButton onClick={() => setTab("stock")}>Stock</ToolbarButton>
                        <ToolbarButton onClick={() => setTab("movements")}>Movements</ToolbarButton>
                        <ToolbarButton onClick={() => setTab("products")}>Products</ToolbarButton>
                        <ToolbarButton onClick={clearAll}>Erase All</ToolbarButton>
                    </div>
                </div>
            </header>

            <main className="max-w-full mx-auto px-4 py-6">
                {/* Floating Search Bar - Only visible on stock tab */}
                {tab === "stock" && (
                    <div className="sticky top-20 z-10 mb-4 bg-white/90 backdrop-blur-sm rounded-2xl border shadow-sm p-3">
                        <div className="flex items-center gap-3">
                            <div className="flex-1">
                                <input
                                    className="w-full rounded-2xl border px-4 py-2 bg-white/80"
                                    placeholder="🔍 Search SKU / style / color / size / fabric / box / pallet / label / location…"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                />
                            </div>
                            {query && (
                                <button
                                    onClick={() => setQuery("")}
                                    className="px-3 py-2 text-gray-500 hover:text-gray-700 rounded-xl hover:bg-gray-100"
                                >
                                    Clear Search
                                </button>
                            )}
                            {sortConfig.key && (
                                <button
                                    onClick={() => setSortConfig({ key: null, direction: 'asc' })}
                                    className="px-3 py-2 text-gray-500 hover:text-gray-700 rounded-xl hover:bg-gray-100"
                                >
                                    Clear Sort
                                </button>
                            )}
                        </div>
                    </div>
                )}
                {tab === "stock" && <StockView />}
                {tab === "movements" && <MovementsManager />}
                {tab === "products" && <ProductsManager />}



                <div className="text-sm text-gray-600 mt-8">
                    <div className="font-medium mb-1">📋 Recommended Workflow</div>
                    <ol className="list-decimal pl-5 space-y-1">
                        <li><strong>Step 1:</strong> Import total inventory via <strong>Stock tab → Import Stock Data</strong> (Style, Color, Size, Balance, Box, Location, Pallet, Fabric, Label)</li>
                        <li><strong>Step 2:</strong> Import daily movements via <strong>Movements tab → Import Movements CSV</strong> (SKU, Style, Color, Size, QTY, Store) - these subtract from inventory</li>
                        <li><strong>Step 3:</strong> View current inventory levels in <strong>Stock tab</strong></li>
                    </ol>

                    <div className="font-medium mb-1 mt-4">🔧 Other Features</div>
                    <ul className="list-disc pl-5 space-y-1">
                        <li>Add/Update Product (Fabric, Box, Pallet, Label)</li>
                        <li>Add/Remove Location</li>
                        <li>Add Movement (RECEIPT / SALE / ADJUST) with Ref, Note, Channel</li>
                        <li>Transfer (auto creates OUT/IN pair)</li>
                        <li>Export Movements CSV | Import Movements CSV</li>
                        <li>
                            Export <b>DETAIL Inventory</b> (SKU × Location; REF__CHANNEL + totals)
                        </li>
                        <li>Export Stock CSV</li>
                        <li>Erase All</li>
                    </ul>
                </div>
            </main>

            {/* Duplicate Resolution Modal */}
            {duplicateModal.show && (
                <DuplicateModal
                    duplicates={duplicateModal.duplicates}
                    onResolve={duplicateModal.onResolve}
                    onCancel={() => setDuplicateModal({ show: false, duplicates: [], onResolve: null })}
                />
            )}
        </div>
    );
}

/* EXPOSE for index.html */
window.App = App;
