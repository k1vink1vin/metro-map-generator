Attribute VB_Name = "ValidateTransfers"
Option Explicit

Private Const COORD_TOLERANCE As Double = 0.0000001

Private Function NormalizeStationName(ByVal value As Variant) As String
    NormalizeStationName = LCase$(Trim$(CStr(value)))
End Function

Public Sub CompleteTransfersAndValidate()
    Dim ws As Worksheet
    Dim lastRow As Long
    Dim rowIndex As Long
    Dim stationName As String
    Dim stationId As String
    Dim latitude As Double
    Dim longitude As Double
    Dim info As Object
    Dim counts As Object
    Dim mismatches As Object
    Dim firstValue As Variant
    Dim mismatchCount As Long
    Dim transferRowCount As Long

    Set ws = ThisWorkbook.Worksheets("Stations")
    lastRow = ws.Cells(ws.Rows.Count, "A").End(xlUp).Row

    Set info = CreateObject("Scripting.Dictionary")
    Set counts = CreateObject("Scripting.Dictionary")
    Set mismatches = CreateObject("Scripting.Dictionary")

    If lastRow < 2 Then
        MsgBox "Stations sheet has no data.", vbExclamation
        Exit Sub
    End If

    ws.Cells(1, "E").Value = "Transfer Group"
    ws.Cells(1, "F").Value = "Transfer Validation"
    ws.Range("E2:F" & lastRow).ClearContents
    ws.Range("A2:F" & lastRow).Interior.Pattern = xlNone

    ' First pass: count station names and validate coordinates.
    For rowIndex = 2 To lastRow
        stationId = Trim$(CStr(ws.Cells(rowIndex, "A").Value))
        stationName = NormalizeStationName(ws.Cells(rowIndex, "B").Value)

        If stationId <> "" And stationName <> "" Then
            If counts.Exists(stationName) Then
                counts(stationName) = CLng(counts(stationName)) + 1
            Else
                counts(stationName) = 1
            End If

            If Not IsNumeric(ws.Cells(rowIndex, "C").Value) Or _
               Not IsNumeric(ws.Cells(rowIndex, "D").Value) Then
                mismatches(stationName) = True
            Else
                latitude = CDbl(ws.Cells(rowIndex, "C").Value)
                longitude = CDbl(ws.Cells(rowIndex, "D").Value)

                If Not info.Exists(stationName) Then
                    info(stationName) = Array(latitude, longitude, stationId, rowIndex)
                Else
                    firstValue = info(stationName)
                    If Abs(latitude - CDbl(firstValue(0))) > COORD_TOLERANCE Or _
                       Abs(longitude - CDbl(firstValue(1))) > COORD_TOLERANCE Then
                        mismatches(stationName) = True
                    End If
                End If
            End If
        End If
    Next rowIndex

    ' Second pass: auto-fill transfer group and validation columns.
    For rowIndex = 2 To lastRow
        stationName = NormalizeStationName(ws.Cells(rowIndex, "B").Value)

        If stationName = "" Then
            ws.Cells(rowIndex, "E").ClearContents
            ws.Cells(rowIndex, "F").ClearContents
        ElseIf counts.Exists(stationName) And CLng(counts(stationName)) > 1 Then
            transferRowCount = transferRowCount + 1
            ws.Cells(rowIndex, "E").Value = Trim$(CStr(ws.Cells(rowIndex, "B").Value))

            If mismatches.Exists(stationName) Then
                ws.Cells(rowIndex, "F").Value = "ERROR - Coordinates Mismatch"
                ws.Range("A" & rowIndex & ":F" & rowIndex).Interior.Color = RGB(254, 202, 202)
            Else
                ws.Cells(rowIndex, "F").Value = "OK - Coordinates Match"
                ws.Range("A" & rowIndex & ":F" & rowIndex).Interior.Color = RGB(220, 252, 231)
            End If
        Else
            ws.Cells(rowIndex, "E").ClearContents
            ws.Cells(rowIndex, "F").ClearContents
        End If
    Next rowIndex

    mismatchCount = mismatches.Count

    If mismatchCount = 0 Then
        MsgBox "Transfer fields completed and validation passed." & vbCrLf & _
               "Transfer-station rows: " & transferRowCount, vbInformation
    Else
        MsgBox "Transfer fields completed, but validation failed." & vbCrLf & _
               mismatchCount & " duplicated station name(s) have inconsistent coordinates." & vbCrLf & _
               "Rows in red need correction.", vbCritical
    End If
End Sub

Public Sub ValidateTransferCoordinates()
    CompleteTransfersAndValidate
End Sub
